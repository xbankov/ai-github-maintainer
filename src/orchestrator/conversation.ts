import { and, eq } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { decisions, proposals, tasks } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, getIssue, listIssueComments } from "../github/issues.js";
import { sessionUrl, type PermissionRule, type SessionMessage } from "../opencode/client.js";
import type { Job } from "../workers/queue.js";
import { enqueue } from "../workers/queue.js";
import { DeferJob, PermanentJobError } from "../workers/processor.js";
import type { OrchestratorContext, Task } from "./context.js";
import { branchFor, enqueueImplementation, taskKey } from "./implementation.js";
import {
  buildApprovalCheckPrompt,
  buildApprovedPlanPrompt,
  buildConversationPrompt,
} from "./prompts.js";
import {
  approvalCheckSchema,
  approvedPlanSchema,
  isImplementable,
  issueFingerprint,
  parseStructured,
  proposalFingerprint,
  renderApprovedPlanComment,
  type ApprovedPlan,
} from "./proposal.js";

/**
 * One OpenCode session per issue is the maintainer's console: the agent
 * investigates and discusses there, the maintainer answers privately in the
 * OpenCode UI and approves in their own words. GitHub only gets short status
 * notes, the approved plan and the pull request.
 */
export const CONVERSATION_JOB = "conversation";
export const conversationDedupeKey = (taskId: number) => `conversation:${taskId}`;

const POLL_MS = 60_000;
const PLAN_ATTEMPTS = 3;

/** Read-only phase: the agent may read and ask questions, nothing else. */
export const CONVERSATION_PERMISSIONS: PermissionRule[] = [
  { action: "question", resource: "*", effect: "allow" },
];

export function enqueueConversation(ctx: OrchestratorContext, task: Task, delayMs = 0) {
  enqueue(ctx.db, {
    type: CONVERSATION_JOB,
    payload: { taskId: task.id },
    repositoryId: task.repositoryId,
    dedupeKey: conversationDedupeKey(task.id),
    maxAttempts: 5,
    availableAt: new Date(Date.now() + delayMs),
  });
}

/** Link to the issue's session for GitHub comments (or its name, without a web URL). */
export function sessionReference(ctx: OrchestratorContext, task: Task, title?: string): string {
  const web = ctx.config.file.opencode.web_url;
  if (web && task.opencodeSessionId) return sessionUrl(web, task.opencodeSessionId);
  return `OpenCode session \`${title ?? `${task.repositoryId}#${task.githubIssueNumber}`}\``;
}

export function operatorLogin(ctx: OrchestratorContext): string {
  return ctx.config.file.opencode.operator ?? ctx.config.file.github.authorized_users[0]!;
}

/**
 * Drives one issue's conversation. Starts the session for a new task, then
 * keeps checking it (deferred every minute) until the maintainer approves or
 * rejects in the session.
 */
export async function conversationStep(
  ctx: OrchestratorContext,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  const { taskId } = job.payload as { taskId: number };
  let task = ctx.task(taskId);
  if (!task) throw new PermanentJobError(`task ${taskId} not found`);
  if (!["DISCOVERED", "ANALYZING", "AWAITING_APPROVAL"].includes(task.status)) return;
  if (task.status === "DISCOVERED" || !task.opencodeSessionId) {
    await startConversation(ctx, task);
    throw new DeferJob(POLL_MS, "conversation started");
  }

  const sessionId = task.opencodeSessionId;
  const messages = await ctx.opencode.messages(sessionId);
  const cursor = task.sessionCursor?.getTime() ?? task.createdAt.getTime();
  const newHuman = messages.filter((m) => m.kind === "human" && m.created > cursor);
  const lastHuman = newHuman.at(-1);
  if (lastHuman) {
    // The maintainer approves in their own words; a strict check decides whether they did.
    // The cursor moves only after the check, so a failed check is retried with the same messages.
    const approved = await isApproval(ctx, sessionId, newHuman, signal);
    const applied = approved && (await approveInSession(ctx, task, lastHuman, signal));
    ctx.db
      .update(tasks)
      .set({ sessionCursor: new Date(lastHuman.created) })
      .where(eq(tasks.id, task.id))
      .run();
    if (applied) return;
    task = ctx.task(task.id)!;
  }

  // Whose turn is it? Pending questions mean the maintainer's, even while the loop runs.
  const agentsTurn =
    (await ctx.opencode.isBusy(sessionId)) &&
    (await ctx.opencode.pendingQuestions(sessionId)) === 0;
  if (agentsTurn) {
    if (task.status === "AWAITING_APPROVAL") {
      task = transitionTask(ctx.db, {
        taskId: task.id,
        to: "ANALYZING",
        trigger: "conversation_continued",
        patch: { inputNotifiedAt: null },
      });
    }
  } else {
    if (task.status === "ANALYZING") {
      task = transitionTask(ctx.db, {
        taskId: task.id,
        to: "AWAITING_APPROVAL",
        trigger: "analysis_completed",
      });
    }
    await notifyIfWaiting(ctx, task, messages);
  }
  await ctx.syncStatusLabel(task);
  throw new DeferJob(POLL_MS, agentsTurn ? "agent working" : "waiting for the maintainer");
}

async function startConversation(ctx: OrchestratorContext, task: Task): Promise<void> {
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  const identity = await ctx.identity();
  const comments = (await listIssueComments(octokit, ref, issue.number)).filter(
    (c) => c.user?.type !== "Bot" && c.user?.login !== identity.botLogin,
  );

  // The issue's worktree: read-only during the conversation, used for the implementation later.
  const wsRepo = ctx.workspaceRepo(repo);
  const branch = branchFor(task);
  const { token } = await ctx.github.createRepositoryToken(ref, { contents: "read" });
  await ctx.workspace.syncRepository(wsRepo, token);
  const worktree = await ctx.workspace.createWorktree(wsRepo, { taskKey: taskKey(task), branch });

  const settings = opencodeSettingsFor(ctx.config, repo);
  const title = `${repo.id}#${issue.number} — ${issue.title}`.slice(0, 120);
  const sessionId =
    task.opencodeSessionId ??
    (await ctx.opencode.createSession({
      directory: worktree.path,
      title,
      agent: settings.analysisAgent,
      model: settings.model,
      permissions: CONVERSATION_PERMISSIONS,
    }));
  const started = new Date();
  ctx.db
    .update(tasks)
    .set({ opencodeSessionId: sessionId, branchName: branch, sessionCursor: started })
    .where(eq(tasks.id, task.id))
    .run();
  ctx.audit({ action: "opencode.session", taskId: task.id, details: { sessionId } });

  await ctx.opencode.send(
    sessionId,
    buildConversationPrompt({
      repository: `${repo.owner}/${repo.name}`,
      instructions: repo.instructions,
      issue,
      comments,
    }),
  );
  const analysing =
    task.status === "DISCOVERED"
      ? transitionTask(ctx.db, {
          taskId: task.id,
          to: "ANALYZING",
          trigger: "analysis_started",
          patch: { issueFingerprint: issueFingerprint(issue) },
        })
      : ctx.task(task.id)!;
  await ctx.syncStatusLabel(analysing);
  await createComment(
    octokit,
    ref,
    issue.number,
    `🤖 Working on this in OpenCode: ${sessionReference(ctx, analysing, title)}`,
  );
}

/** One GitHub notice per waiting period, after `input_wait_minutes` without activity. */
async function notifyIfWaiting(ctx: OrchestratorContext, task: Task, messages: SessionMessage[]) {
  if (task.inputNotifiedAt) return;
  // Activity = any message in the session (agent, maintainer or service).
  const lastActivity = Math.max(0, ...messages.map((m) => m.created));
  const waitMs = ctx.config.file.limits.input_wait_minutes * 60_000;
  if (Date.now() - lastActivity < waitMs) return;
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  await createComment(
    octokit,
    ref,
    task.githubIssueNumber,
    `@${operatorLogin(ctx)} 🤖 Waiting for your input: ${sessionReference(ctx, task)}`,
  );
  ctx.db.update(tasks).set({ inputNotifiedAt: new Date() }).where(eq(tasks.id, task.id)).run();
}

/** Sends a short note from the service into the session (visible to the maintainer). */
async function tell(ctx: OrchestratorContext, task: Task, text: string) {
  await ctx.opencode.send(task.opencodeSessionId!, `[maintainer service] ${text}`);
}

/**
 * Strict check of the maintainer's new messages: only an unambiguous go-ahead
 * to implement counts as approval (questions, conditions or change requests do not).
 */
async function isApproval(
  ctx: OrchestratorContext,
  sessionId: string,
  messages: SessionMessage[],
  signal: AbortSignal,
): Promise<boolean> {
  const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await ctx.opencode.generate(
      sessionId,
      buildApprovalCheckPrompt(messages.map((m) => m.text)),
      timeoutMs,
      signal,
    );
    const parsed = parseStructured(reply, approvalCheckSchema);
    if (parsed.ok) return parsed.value.approved;
  }
  return false; // when in doubt, it is not an approval
}

/**
 * The maintainer approved in the session: write down the agreed plan, record the
 * decision, publish the plan on the issue and start the implementation.
 * Returns false when the approval could not be applied (the maintainer is told why).
 */
async function approveInSession(
  ctx: OrchestratorContext,
  task: Task,
  command: SessionMessage,
  signal: AbortSignal,
): Promise<boolean> {
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const sessionId = task.opencodeSessionId!;

  // Resuming after a crash: the decision may already be recorded.
  const existing = ctx.db
    .select()
    .from(decisions)
    .where(eq(decisions.sessionMessageId, command.id))
    .get();
  if (!existing) {
    if (await ctx.opencode.isBusy(sessionId))
      await ctx.opencode.interrupt(sessionId).catch(() => undefined);
    const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
    let plan: ApprovedPlan | undefined;
    let error: string | undefined;
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS && !plan; attempt++) {
      const reply = await ctx.opencode.generate(
        sessionId,
        buildApprovedPlanPrompt(error),
        timeoutMs,
        signal,
      );
      const result = parseStructured(reply, approvedPlanSchema);
      if (result.ok) plan = result.value;
      else error = result.error;
    }
    if (!plan || !isImplementable(plan)) {
      await tell(
        ctx,
        task,
        plan
          ? "Approval not applied: the agreed plan has no implementation steps or the issue was judged invalid. Refine the plan, then approve again."
          : "Approval not applied: I could not write down the agreed plan. Please confirm the approval again.",
      );
      return false;
    }

    const operator = operatorLogin(ctx);
    const operatorId =
      [...(await ctx.maintainers(ref)).entries()].find(
        ([, login]) => login.toLowerCase() === operator.toLowerCase(),
      )?.[0] ?? 0;
    const version = task.proposalVersion + 1;
    let current = ctx.task(task.id)!;
    if (current.status === "ANALYZING") {
      current = transitionTask(ctx.db, {
        taskId: current.id,
        to: "AWAITING_APPROVAL",
        trigger: "analysis_completed",
      });
    }
    transitionTask(ctx.db, {
      taskId: current.id,
      to: "APPROVED",
      trigger: "approve_command",
      actor: `opencode:${operator}`,
      patch: { proposalVersion: version, approvedVersion: version, inputNotifiedAt: null },
      details: { version, sessionMessageId: command.id },
      within: (tx) => {
        tx.update(proposals)
          .set({ status: "superseded" })
          .where(and(eq(proposals.taskId, current.id), eq(proposals.status, "pending")))
          .run();
        tx.insert(proposals)
          .values({
            taskId: current.id,
            version,
            content: plan,
            fingerprint: proposalFingerprint(plan),
            status: "approved",
          })
          .run();
        tx.insert(decisions)
          .values({
            taskId: current.id,
            proposalVersion: version,
            decision: "approve",
            githubUser: operator,
            githubUserId: operatorId,
            source: "opencode",
            sessionMessageId: command.id,
          })
          .run();
      },
    });
  }

  // Publish the approved plan (idempotent) and start the implementation.
  const approved = ctx.task(task.id)!;
  const row = ctx.db
    .select()
    .from(proposals)
    .where(
      and(eq(proposals.taskId, approved.id), eq(proposals.version, approved.approvedVersion ?? 0)),
    )
    .get();
  if (row && !row.githubCommentId) {
    const posted = await createComment(
      octokit,
      ref,
      approved.githubIssueNumber,
      renderApprovedPlanComment({
        taskId: approved.id,
        version: row.version,
        plan: row.content as ApprovedPlan,
        approvedBy: operatorLogin(ctx),
      }),
    );
    ctx.db
      .update(proposals)
      .set({ githubCommentId: posted.id, publishedAt: new Date(posted.createdAt) })
      .where(eq(proposals.id, row.id))
      .run();
  }
  if (approved.status === "APPROVED") {
    enqueueImplementation(ctx, approved);
    await ctx.syncStatusLabel(approved);
    await tell(
      ctx,
      approved,
      `Approved as plan v${approved.approvedVersion}. The implementation starts in this session.`,
    );
  }
  return true;
}

/** The issue text changed on GitHub: tell the agent in the session. */
export async function forwardIssueChange(
  ctx: OrchestratorContext,
  task: Task,
  message: string,
  fingerprint: string,
) {
  if (!task.opencodeSessionId) return;
  await ctx.opencode.send(task.opencodeSessionId, message);
  ctx.db.update(tasks).set({ issueFingerprint: fingerprint }).where(eq(tasks.id, task.id)).run();
}

/** The conversation job kept failing (e.g. OpenCode down): fail the analysis, or keep watching later. */
export async function onConversationDead(ctx: OrchestratorContext, job: Job): Promise<void> {
  const { taskId } = job.payload as { taskId: number };
  const task = ctx.task(taskId);
  if (!task) return;
  if (task.status === "AWAITING_APPROVAL") {
    enqueueConversation(ctx, task, 10 * 60_000); // the maintainer may still be talking; look again later
    return;
  }
  if (task.status !== "ANALYZING") return;
  const failed = transitionTask(ctx.db, {
    taskId: task.id,
    to: "FAILED",
    trigger: "analysis_failed",
    patch: { lastError: job.lastError ?? "conversation failed" },
  });
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  await ctx.syncStatusLabel(failed);
  await createComment(
    octokit,
    ref,
    task.githubIssueNumber,
    "🤖 The AI session stopped working after several attempts. Remove and re-add the label to retry.",
  );
}
