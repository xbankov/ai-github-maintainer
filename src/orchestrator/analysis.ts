import { and, desc, eq } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { decisions, proposals } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import {
  createComment,
  findLabelActor,
  getIssue,
  listIssueComments,
  setStatusLabel,
} from "../github/issues.js";
import type { Job } from "../workers/queue.js";
import { PermanentJobError } from "../workers/processor.js";
import type { OrchestratorContext, Task } from "./context.js";
import { buildAnalysisPrompt, buildProposalJsonPrompt } from "./prompts.js";
import {
  issueFingerprint,
  parseProposal,
  PROPOSAL_MARKER,
  proposalFingerprint,
  renderProposalComment,
  type Proposal,
} from "./proposal.js";

export const ANALYZE_JOB = "analyze-issue";

export interface AnalyzePayload {
  taskId: number;
}

export const analyzeDedupeKey = (taskId: number) => `analyze:${taskId}`;

const JSON_ATTEMPTS = 3;

/** Retryable: the issue changed while the agent was working; analyse the new text. */
export class IssueChangedError extends Error {
  override name = "IssueChangedError";
}

/**
 * Analyses one issue with the read-only OpenCode agent and publishes a new
 * proposal version.
 *
 * Safe to retry at any point: the proposal row and the task transition are
 * committed in one transaction; publishing is idempotent (an already-posted
 * comment is found by its marker); labels are reconciled from the task state.
 * The abort signal (job timeout) interrupts the agent.
 */
export async function analyzeIssue(
  ctx: OrchestratorContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const payload = job.payload as AnalyzePayload;
  let task = ctx.task(payload.taskId);
  if (!task) throw new PermanentJobError(`task ${payload.taskId} not found`);
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const log = ctx.logger.child({
    component: "analysis",
    taskId: task.id,
    issue: task.githubIssueNumber,
  });
  const octokit = await ctx.github.octokitFor(ref);

  // The proposal is stored; publishing (or labelling) was interrupted: finish that only.
  if (task.status === "AWAITING_APPROVAL") {
    const latest = ctx.latestProposal(task.id);
    if (latest && !latest.publishedAt) {
      await publish(ctx, task, latest.version, latest.content as Proposal);
    }
    await ctx.syncStatusLabel(task);
    return;
  }
  if (task.status !== "DISCOVERED" && task.status !== "ANALYZING") {
    log.info({ status: task.status }, "nothing to analyse in this state");
    return;
  }
  if (task.status === "DISCOVERED") {
    task = transitionTask(ctx.db, {
      taskId: task.id,
      to: "ANALYZING",
      trigger: "analysis_started",
    });
  }

  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, "running");
  const identity = await ctx.identity();
  const comments = (await listIssueComments(octokit, ref, issue.number)).filter(
    (c) => c.user?.type !== "Bot" && c.user?.login !== identity.botLogin,
  );
  const fingerprint = issueFingerprint(issue);
  const previous = ctx.latestProposal(task.id);
  const revision = pendingRevision(ctx, task);

  // Read-only snapshot of the latest default branch for the agent to inspect.
  const wsRepo = ctx.workspaceRepo(repo);
  const snapshotKey = `analysis-${task.id}`;
  const { token } = await ctx.github.createRepositoryToken(ref, { contents: "read" });
  await ctx.workspace.syncRepository(wsRepo, token);
  const snapshot = await ctx.workspace.createSnapshot(wsRepo, snapshotKey);

  const settings = opencodeSettingsFor(ctx.config, repo);
  const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
  let sessionId: string | undefined;
  let proposal: Proposal;
  try {
    sessionId = await ctx.opencode.createSession({
      directory: snapshot.path,
      title: `${repo.id}#${issue.number} analysis`,
      agent: settings.analysisAgent,
      model: settings.model,
    });
    await ctx.opencode.run(
      sessionId,
      buildAnalysisPrompt({
        repository: `${repo.owner}/${repo.name}`,
        instructions: repo.instructions,
        issue,
        comments,
        revision: revision
          ? {
              instructions: revision.instructions ?? "",
              by: revision.githubUser,
              previous: previous ? (previous.content as Proposal) : undefined,
            }
          : undefined,
      }),
      timeoutMs,
      signal,
    );
    let lastError: string | undefined;
    let parsed: Proposal | undefined;
    for (let attempt = 1; attempt <= JSON_ATTEMPTS && !parsed; attempt++) {
      const reply = await ctx.opencode.generate(
        sessionId,
        buildProposalJsonPrompt(lastError),
        timeoutMs,
        signal,
      );
      const result = parseProposal(reply);
      if (result.ok) parsed = result.proposal;
      else {
        lastError = result.error;
        log.warn({ attempt, error: result.error }, "structured answer rejected");
      }
    }
    if (!parsed) throw new Error(`model did not return a valid proposal: ${lastError}`);
    proposal = parsed;
  } finally {
    if (sessionId) await ctx.opencode.deleteSession(sessionId).catch(() => undefined);
    await ctx.workspace.removeWorktree(wsRepo, { taskKey: snapshotKey }).catch(() => undefined);
  }
  signal.throwIfAborted();

  // The task or the issue may have changed while the agent worked.
  const current = ctx.task(task.id);
  if (current?.status !== "ANALYZING") {
    log.info({ status: current?.status }, "task changed during analysis; result discarded");
    return;
  }
  const now = await getIssue(octokit, ref, issue.number);
  const allowedLabel = ctx.config.file.github.allowed_label;
  if (now.state !== "open" || !now.labels.includes(allowedLabel)) {
    // The next sync stops the task; do not publish anything for it.
    log.info({ state: now.state }, "issue closed or no longer allowed; result discarded");
    return;
  }
  const actor = await findLabelActor(octokit, ref, now.number, allowedLabel);
  if (!actor || !(await ctx.maintainers(ref)).has(actor.id)) {
    log.info("allowed label is no longer from a maintainer; result discarded");
    return;
  }
  if (issueFingerprint(now) !== fingerprint) {
    throw new IssueChangedError("the issue changed during analysis; analysing the new version");
  }

  // Store the proposal and move the task in one transaction.
  const fp = proposalFingerprint(proposal);
  const unchanged = previous && previous.fingerprint === fp;
  const version = unchanged ? previous.version : current.proposalVersion + 1;
  task = transitionTask(ctx.db, {
    taskId: current.id,
    to: "AWAITING_APPROVAL",
    trigger: "analysis_completed",
    patch: {
      proposalVersion: version,
      approvedVersion: null,
      issueFingerprint: fingerprint,
      lastError: null,
    },
    details: { version, unchanged: Boolean(unchanged), revision: Boolean(revision) },
    within: (tx) => {
      if (unchanged) {
        // Same content as before: it is pending a (new) decision again.
        tx.update(proposals).set({ status: "pending" }).where(eq(proposals.id, previous.id)).run();
        return;
      }
      tx.update(proposals)
        .set({ status: "superseded" })
        .where(and(eq(proposals.taskId, current.id), eq(proposals.status, "pending")))
        .run();
      tx.insert(proposals)
        .values({
          taskId: current.id,
          version,
          content: proposal,
          fingerprint: fp,
          status: "pending",
        })
        .run();
    },
  });
  log.info({ version, unchanged: Boolean(unchanged) }, "analysis complete");

  if (unchanged) {
    const notice = await createComment(
      octokit,
      ref,
      issue.number,
      `🤖 Re-analysis produced the same proposal (v${version}); it still applies. ` +
        "Any previous approval has been reset — reply `/ai approve` to approve it again.",
    );
    // Commands must refer to this re-confirmation, not to the original publication.
    ctx.db
      .update(proposals)
      .set({ publishedAt: new Date(notice.createdAt) })
      .where(eq(proposals.id, previous.id))
      .run();
  } else {
    await publish(ctx, task, version, proposal);
  }
  await ctx.syncStatusLabel(task);
}

/** The latest /ai revise decision for the current proposal version, if any. */
function pendingRevision(ctx: OrchestratorContext, task: Task) {
  const latest = ctx.db
    .select()
    .from(decisions)
    .where(eq(decisions.taskId, task.id))
    .orderBy(desc(decisions.id))
    .limit(1)
    .get();
  return latest?.decision === "revise" && latest.proposalVersion === task.proposalVersion
    ? latest
    : undefined;
}

/** Posts (or finds an already-posted) proposal comment and records when it became visible. */
async function publish(ctx: OrchestratorContext, task: Task, version: number, proposal: Proposal) {
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const identity = await ctx.identity();
  const existing = (await listIssueComments(octokit, ref, task.githubIssueNumber)).find((c) => {
    const m = PROPOSAL_MARKER.exec(c.body);
    return (
      c.user?.login === identity.botLogin &&
      m &&
      Number(m[1]) === task.id &&
      Number(m[2]) === version
    );
  });
  const posted =
    existing ??
    (await createComment(
      octokit,
      ref,
      task.githubIssueNumber,
      renderProposalComment({ taskId: task.id, version, proposal }),
    ));
  ctx.db
    .update(proposals)
    .set({ githubCommentId: posted.id, publishedAt: new Date(posted.createdAt) })
    .where(and(eq(proposals.taskId, task.id), eq(proposals.version, version)))
    .run();
  ctx.audit({
    action: "proposal.published",
    repositoryId: task.repositoryId,
    taskId: task.id,
    details: { version, commentId: posted.id },
  });
}

/** Called when an analysis job has failed for the last time. */
export async function onAnalysisDead(ctx: OrchestratorContext, job: Job): Promise<void> {
  const payload = job.payload as AnalyzePayload;
  const task = ctx.task(payload.taskId);
  if (!task || task.status !== "ANALYZING") return;
  const failed = transitionTask(ctx.db, {
    taskId: task.id,
    to: "FAILED",
    trigger: "analysis_failed",
    patch: { lastError: job.lastError ?? "analysis failed" },
  });
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  await ctx.syncStatusLabel(failed);
  await createComment(
    octokit,
    ref,
    task.githubIssueNumber,
    `🤖 The analysis failed after ${job.attempts} attempts. A maintainer can retry with \`/ai revise <guidance>\`.`,
  );
}
