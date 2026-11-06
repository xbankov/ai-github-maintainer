import { and, desc, eq } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { acquireLock, releaseLock, repoLockName, taskLockOwner } from "../database/locks.js";
import { decisions, proposals, tasks } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, getIssue } from "../github/issues.js";
import {
  createPullRequest,
  findOpenPullRequest,
  getCiResult,
  getJobLogTail,
  getPullRequest,
  markReadyForReview,
  type CiResult,
} from "../github/pull-requests.js";
import type { PermissionRule } from "../opencode/client.js";
import type { Job } from "../workers/queue.js";
import { enqueue } from "../workers/queue.js";
import { DeferJob, PermanentJobError } from "../workers/processor.js";
import type { OrchestratorContext, Task } from "./context.js";
import { buildCiFixPrompt, buildImplementationPrompt, buildReviewPrompt } from "./prompts.js";
import { sanitize, type Proposal } from "./proposal.js";

export const IMPLEMENT_JOB = "implement-task";
export const CI_JOB = "await-ci";
export const implementDedupeKey = (taskId: number) => `implement:${taskId}`;
export const ciDedupeKey = (taskId: number) => `ci:${taskId}`;

export interface ImplementPayload {
  taskId: number;
  /** Set when CI failed and the agent must fix it. */
  ciFix?: { round: number; failures: string[]; logs: string };
  /** Set when maintainers asked for changes on the pull request. */
  review?: { round: number; feedback: string };
}

/** Paths the agent must never change; changes there are discarded before committing. */
export function isProtectedPath(file: string): boolean {
  const f = file.replace(/^\.\//, "");
  if (f.startsWith(".github/") || f === ".gitmodules") return true;
  return /(^|\/)\.env(\..*)?$/.test(f) && !/(^|\/)\.env\.example$/.test(f);
}

/** Session rules for the build agent, on top of the deny-by-default base rules. */
export const BUILD_SESSION_PERMISSIONS: PermissionRule[] = [
  { action: "edit", resource: "*", effect: "allow" },
  { action: "edit", resource: ".github/*", effect: "deny" },
  { action: "edit", resource: "*.env", effect: "deny" },
  { action: "bash", resource: "*", effect: "deny" },
  { action: "bash", resource: "git status*", effect: "allow" },
  { action: "bash", resource: "git diff*", effect: "allow" },
  { action: "bash", resource: "git log*", effect: "allow" },
  { action: "bash", resource: "git show*", effect: "allow" },
  { action: "bash", resource: "ls*", effect: "allow" },
];

const LOCK_LEASE_MS = 30 * 24 * 3_600_000;
const POLL_MS = 60_000;

export const taskKey = (task: Task) => `task-${task.id}`;
export const branchFor = (task: Task) => task.branchName ?? `ai/issue-${task.githubIssueNumber}`;

function approvedProposal(ctx: OrchestratorContext, task: Task) {
  if (!task.approvedVersion) return undefined;
  const row = ctx.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.taskId, task.id), eq(proposals.version, task.approvedVersion)))
    .get();
  if (!row || row.status !== "approved") return undefined;
  const decision = ctx.db
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.taskId, task.id),
        eq(decisions.proposalVersion, task.approvedVersion),
        eq(decisions.decision, "approve"),
      ),
    )
    .orderBy(desc(decisions.id))
    .get();
  return decision ? { row, decision } : undefined;
}

export function enqueueImplementation(
  ctx: OrchestratorContext,
  task: Task,
  payload?: ImplementPayload,
) {
  enqueue(ctx.db, {
    type: IMPLEMENT_JOB,
    payload: { ...(payload ?? { taskId: task.id }) },
    repositoryId: task.repositoryId,
    dedupeKey: implementDedupeKey(task.id),
    maxAttempts: 3,
  });
}

function enqueueCiCheck(ctx: OrchestratorContext, task: Task) {
  enqueue(ctx.db, {
    type: CI_JOB,
    payload: { taskId: task.id },
    repositoryId: task.repositoryId,
    dedupeKey: ciDedupeKey(task.id),
    maxAttempts: 5,
    availableAt: new Date(Date.now() + POLL_MS),
  });
}

/**
 * Implements an approved proposal: build agent in the task worktree, commit as
 * the bot, push, open a draft pull request, then hand over to the CI check.
 * Never runs without an approval of the current proposal version.
 */
export async function implementTask(
  ctx: OrchestratorContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const stored = job.payload as ImplementPayload;
  let task = ctx.task(stored.taskId);
  if (!task) throw new PermanentJobError(`task ${stored.taskId} not found`);
  if (task.status !== "APPROVED" && task.status !== "IMPLEMENTING") return;
  // A review round's feedback is stored with the task, so a recovered job still has it.
  const pending = task.pendingFeedback
    ? (JSON.parse(task.pendingFeedback) as { round: number; text: string })
    : undefined;
  const payload: ImplementPayload =
    !stored.review && !stored.ciFix && pending && task.status === "IMPLEMENTING"
      ? { ...stored, review: { round: pending.round, feedback: pending.text } }
      : stored;
  const approved = approvedProposal(ctx, task);
  if (!approved || approved.row.version !== task.proposalVersion) {
    throw new PermanentJobError(
      "refusing to implement: no approval for the current proposal version",
    );
  }

  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const wsRepo = ctx.workspaceRepo(repo);
  const log = ctx.logger.child({ component: "implementation", taskId: task.id });
  if (!acquireLock(ctx.db, repoLockName(repo.id), taskLockOwner(task.id), LOCK_LEASE_MS)) {
    throw new DeferJob(5 * 60_000, "another implementation holds the repository lock");
  }

  const branch = branchFor(task);
  if (task.status === "APPROVED") {
    task = transitionTask(ctx.db, {
      taskId: task.id,
      to: "IMPLEMENTING",
      trigger: "implementation_started",
      patch: { branchName: branch, ciAttempts: 0 },
      details: { version: approved.row.version },
    });
  }
  await ctx.syncStatusLabel(task);

  const octokit = await ctx.github.octokitFor(ref);
  const { token } = await ctx.github.createRepositoryToken(ref, { contents: "write" });
  await ctx.workspace.syncRepository(wsRepo, token);
  const worktree = await ctx.workspace.createWorktree(wsRepo, { taskKey: taskKey(task), branch });
  // The worktree was created when the conversation started: build on the latest default branch.
  if (
    !payload.ciFix &&
    !payload.review &&
    (await ctx.workspace.commitsAhead(wsRepo, branch)) === 0
  ) {
    await ctx.workspace.resetToDefault(wsRepo, taskKey(task));
  }
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  const proposal = approved.row.content as Proposal;
  const settings = opencodeSettingsFor(ctx.config, repo);
  const limits = ctx.config.file.limits;

  const prompt = payload.review
    ? buildReviewPrompt({
        round: payload.review.round,
        maxRounds: ctx.config.file.limits.max_review_iterations,
        feedback: payload.review.feedback,
      })
    : payload.ciFix
      ? buildCiFixPrompt({
          round: payload.ciFix.round,
          maxRounds: limits.max_implementation_retries,
          failures: payload.ciFix.failures,
          logs: payload.ciFix.logs,
        })
      : buildImplementationPrompt({
          repository: `${repo.owner}/${repo.name}`,
          branch,
          instructions: repo.instructions,
          issue,
          proposal,
          version: approved.row.version,
          approvedBy: approved.decision.githubUser,
        });

  // The issue's conversation session continues with the build agent (one session per issue).
  const newSession = async () => {
    const id = await ctx.opencode.createSession({
      directory: worktree.path,
      title: `${repo.id}#${issue.number} — ${issue.title}`.slice(0, 120),
      agent: settings.implementationAgent,
      model: settings.model,
      permissions: BUILD_SESSION_PERMISSIONS,
    });
    ctx.db.update(tasks).set({ opencodeSessionId: id }).where(eq(tasks.id, task!.id)).run();
    ctx.audit({ action: "opencode.session", taskId: task!.id, details: { sessionId: id } });
    task = { ...task!, opencodeSessionId: id };
    return id;
  };
  let sessionId = task.opencodeSessionId ?? (await newSession());
  await ctx.opencode
    .switchMode(sessionId, settings.implementationAgent, BUILD_SESSION_PERMISSIONS)
    .catch((err: unknown) =>
      log.warn({ err: (err as Error).message }, "could not switch session mode"),
    );
  const timeoutMs = limits.task_timeout_minutes * 60_000;
  let summary: string;
  try {
    summary = await ctx.opencode.run(sessionId, prompt, timeoutMs, signal);
  } catch (err) {
    if (signal.aborted || !task.opencodeSessionId) throw err;
    // The stored session may be gone (e.g. deleted on the server): start a fresh one.
    log.warn({ err: (err as Error).message }, "stored session unusable; starting a new one");
    sessionId = await newSession();
    summary = await ctx.opencode.run(
      sessionId,
      payload.ciFix || payload.review
        ? buildImplementationPrompt({
            repository: `${repo.owner}/${repo.name}`,
            branch,
            instructions: repo.instructions,
            issue,
            proposal,
            version: approved.row.version,
            approvedBy: approved.decision.githubUser,
          }) + `\n\n${prompt}`
        : prompt,
      timeoutMs,
      signal,
    );
  }
  signal.throwIfAborted();

  // Enforce the rules on the result, independent of the agent.
  const changed = await ctx.workspace.changedFiles(wsRepo, taskKey(task));
  const protectedChanges = changed.filter(isProtectedPath);
  if (protectedChanges.length) {
    await ctx.workspace.discardPaths(wsRepo, taskKey(task), protectedChanges);
    log.warn({ files: protectedChanges }, "discarded changes to protected paths");
  }
  const identity = await ctx.identity();
  const title = proposal.summary.replace(/\s+/g, " ").slice(0, 72);
  await ctx.workspace.commitAll(
    wsRepo,
    taskKey(task),
    payload.review
      ? `Address review round ${payload.review.round} for #${issue.number}`
      : payload.ciFix
        ? `Fix CI for #${issue.number} (round ${payload.ciFix.round})`
        : `${title} (#${issue.number})\n\nImplements approved proposal v${approved.row.version} for #${issue.number}.`,
    { name: identity.botLogin, email: identity.botEmail },
  );
  if ((await ctx.workspace.commitsAhead(wsRepo, branch)) === 0) {
    throw new Error("the agent made no changes");
  }

  // The task may have been stopped while the agent worked.
  const current = ctx.task(task.id);
  if (current?.status !== "IMPLEMENTING") {
    log.info({ status: current?.status }, "task changed during implementation; not pushing");
    return;
  }

  // A human may have merged or closed the PR meanwhile: then do not push (the next sync finishes the task).
  if (current.githubPrNumber) {
    const before = await getPullRequest(octokit, ref, current.githubPrNumber);
    if (before.state !== "open") {
      log.info(
        { pr: before.number, merged: before.merged },
        "pull request no longer open; not pushing",
      );
      return;
    }
  }
  const push = await ctx.github.createRepositoryToken(ref, { contents: "write" });
  await ctx.workspace.pushBranch(wsRepo, branch, push.token);

  let pr = current.githubPrNumber
    ? await getPullRequest(octokit, ref, current.githubPrNumber)
    : await findOpenPullRequest(octokit, ref, branch);
  const firstPr = !pr;
  if (!pr) {
    pr = await createPullRequest(octokit, ref, {
      head: branch,
      base: repo.default_branch,
      title: `${title} (#${issue.number})`,
      body: renderPrBody({
        issueNumber: issue.number,
        proposal,
        version: approved.row.version,
        approvedBy: approved.decision.githubUser,
        proposalCommentId: approved.row.githubCommentId,
        agentSummary: summary,
        discarded: protectedChanges,
      }),
    });
  }
  task = transitionTask(ctx.db, {
    taskId: current.id,
    to: "TESTING",
    trigger: "implementation_finished",
    patch: {
      githubPrNumber: pr.number,
      ...(payload.ciFix ? { ciAttempts: payload.ciFix.round } : {}),
      ...(payload.review ? { ciAttempts: 0, pendingFeedback: null } : {}),
    },
    details: { pr: pr.number, commit: await ctx.workspace.headCommit(wsRepo, taskKey(current)) },
  });
  enqueueCiCheck(ctx, task);
  if (firstPr) {
    await createComment(
      octokit,
      ref,
      issue.number,
      `🤖 Draft pull request #${pr.number} opened for proposal v${approved.row.version}. It becomes ready for review when CI passes.`,
    );
  } else if (payload.review) {
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 Review round ${payload.review.round}:\n\n${sanitize(summary).slice(0, 3000) || "(no notes)"}`,
    );
  } else if (payload.ciFix) {
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 Pushed a fix for the failing checks (round ${payload.ciFix.round}).`,
    );
  }
}

export function renderPrBody(input: {
  issueNumber: number;
  proposal: Proposal;
  version: number;
  approvedBy: string;
  proposalCommentId: number | null;
  agentSummary: string;
  discarded: string[];
}): string {
  const p = input.proposal;
  const link = input.proposalCommentId
    ? `#${input.issueNumber} (comment ${input.proposalCommentId})`
    : `#${input.issueNumber}`;
  return [
    `Closes #${input.issueNumber}`,
    "",
    `**Summary:** ${sanitize(p.summary)}`,
    `**Approved proposal:** v${input.version} by @${input.approvedBy} — ${link}`,
    "",
    "### Plan",
    ...p.implementation.map((s, i) => `${i + 1}. ${sanitize(s)}`),
    "",
    "### Agent notes",
    sanitize(input.agentSummary).slice(0, 3000) || "(none)",
    ...(input.discarded.length
      ? [
          "",
          `⚠️ Discarded changes to protected files: ${input.discarded.map((f) => `\`${f}\``).join(", ")}`,
        ]
      : []),
    "",
    "### Checks",
    "CI runs on this pull request. The bot marks it ready for review when the checks pass.",
    "",
    "---",
    "🤖 Generated by the AI maintainer. Please review carefully — the bot never merges.",
  ].join("\n");
}

/**
 * Polls CI for the task's pull request. Success → ready for review (PR_OPEN).
 * Failure → back to the agent with the logs, up to max_implementation_retries
 * rounds; then FAILED for a human.
 */
export async function awaitCi(ctx: OrchestratorContext, job: Job): Promise<void> {
  const { taskId } = job.payload as { taskId: number };
  const task = ctx.task(taskId);
  if (!task || task.status !== "TESTING" || !task.githubPrNumber) return;
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const limits = ctx.config.file.limits;
  const pr = await getPullRequest(octokit, ref, task.githubPrNumber);
  if (pr.state === "closed") return; // handled by the review loop (Milestone 4)

  const ci: CiResult = await getCiResult(octokit, ref, pr.headSha);
  const waitedMs = Date.now() - job.createdAt.getTime();
  if (ci.state === "none" && waitedMs < limits.ci_grace_minutes * 60_000)
    throw new DeferJob(POLL_MS, "no checks yet");
  if (ci.state === "pending" && waitedMs < limits.ci_timeout_minutes * 60_000)
    throw new DeferJob(POLL_MS, "checks running");

  if (ci.state === "failure") {
    const round = task.ciAttempts + 1;
    if (round > limits.max_implementation_retries) {
      await failImplementation(
        ctx,
        task,
        `CI still failing after ${task.ciAttempts} fix round(s): ${ci.failures.map((f) => f.name).join(", ")}`,
      );
      return;
    }
    const logs: string[] = [];
    for (const f of ci.failures.filter((x) => x.jobId).slice(0, 3)) {
      const tail = await getJobLogTail(octokit, ref, f.jobId!, 8_000).catch(
        () => "(log unavailable)",
      );
      logs.push(`### ${f.name}\n${tail}`);
    }
    const back = transitionTask(ctx.db, {
      taskId: task.id,
      to: "IMPLEMENTING",
      trigger: "checks_failed",
      details: { round, failures: ci.failures.map((f) => f.name) },
    });
    enqueueImplementation(ctx, back, {
      taskId: task.id,
      ciFix: { round, failures: ci.failures.map((f) => f.name), logs: logs.join("\n\n") },
    });
    await ctx.syncStatusLabel(back);
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 CI failed (${ci.failures.map((f) => `\`${f.name}\``).join(", ")}). Fixing it — round ${round} of ${limits.max_implementation_retries}.`,
    );
    return;
  }

  // success, no CI at all, or CI still running after the timeout
  const note =
    ci.state === "success"
      ? `All ${ci.total} check(s) passed.`
      : ci.state === "none"
        ? "⚠️ No CI checks ran for this pull request — please test it yourself."
        : `⚠️ CI was still running after ${limits.ci_timeout_minutes} minutes — check the results before merging.`;
  await markReadyForReview(octokit, pr);
  const open = transitionTask(ctx.db, {
    taskId: task.id,
    to: "PR_OPEN",
    trigger: "pr_opened",
    // Reviews are counted from the moment the PR first became ready (not reset by later rounds).
    ...(task.reviewCursor ? {} : { patch: { reviewCursor: new Date() } }),
    details: { pr: pr.number, ci: ci.state },
  });
  await ctx.syncStatusLabel(open);
  await createComment(
    octokit,
    ref,
    pr.number,
    `🤖 Ready for review. ${note} The bot never merges.`,
  );
  await createComment(
    octokit,
    ref,
    task.githubIssueNumber,
    `🤖 Pull request #${pr.number} is ready for review. ${note}`,
  );
}

/** Final failure of an implementation: FAILED, release the repository, tell the humans. */
export async function failImplementation(
  ctx: OrchestratorContext,
  task: Task,
  reason: string,
): Promise<void> {
  const current = ctx.task(task.id);
  if (!current || !["APPROVED", "IMPLEMENTING", "TESTING"].includes(current.status)) return;
  const failed = transitionTask(ctx.db, {
    taskId: current.id,
    to: "FAILED",
    trigger: "implementation_failed",
    patch: { lastError: reason.slice(0, 2000) },
  });
  releaseLock(ctx.db, repoLockName(current.repositoryId), taskLockOwner(current.id));
  const ref = ctx.ref(ctx.repository(current.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  await ctx.syncStatusLabel(failed);
  const text = `🤖 Implementation stopped: ${sanitize(reason)}\n\nA maintainer can retry with \`/ai revise <guidance>\`.`;
  if (current.githubPrNumber) await createComment(octokit, ref, current.githubPrNumber, text);
  await createComment(octokit, ref, current.githubIssueNumber, text);
}

export async function onImplementationDead(ctx: OrchestratorContext, job: Job): Promise<void> {
  const { taskId } = job.payload as { taskId: number };
  const task = ctx.task(taskId);
  if (task)
    await failImplementation(ctx, task, `the ${job.type} job failed ${job.attempts} time(s)`);
}
