import { and, eq, inArray, isNull } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { releaseLock, repoLockName, taskLockOwner } from "../database/locks.js";
import { events, tasks } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, listIssueComments, removeLabel } from "../github/issues.js";
import {
  getPullRequest,
  listReviewComments,
  listReviews,
  type PullRequestInfo,
} from "../github/pull-requests.js";
import { canTransition } from "./state-machine.js";
import type { OrchestratorContext, Task } from "./context.js";
import { CONVERSATION_PERMISSIONS, enqueueConversation, sessionReference } from "./conversation.js";
import { branchFor, enqueueImplementation, taskKey } from "./implementation.js";
import { buildScopeCheckPrompt } from "./prompts.js";
import { parseStructured, scopeCheckSchema } from "./proposal.js";

/** Task states in which a pull request may exist and must be watched for merge/close. */
export const PR_TRACKED_STATES = [
  "ANALYZING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "IMPLEMENTING",
  "TESTING",
  "PR_OPEN",
  "CHANGES_REQUESTED",
  "READY_FOR_HUMAN_MERGE",
  "FAILED",
] as const;

export type PrOutcome = "completed" | "abandoned" | "ready" | "iterating" | "scope-change" | "none";

/** GitHub timestamps have second precision: look back a little and dedupe by id. */
const OVERLAP_MS = 60_000;
const FEEDBACK_EVENT = "pr_feedback";

interface FeedbackEvent {
  key: string;
  at: number;
  kind: "approval" | "feedback";
  source: "github" | "session";
  text: string;
}

/**
 * Reconciles one task with its pull request (called on every sync):
 * merged → COMPLETED, closed → ABANDONED, a maintainer approval that comes
 * after all feedback → stop and wait for the human merge, maintainer feedback
 * → another round in the session. Never merges, never reopens a closed PR.
 */
export async function reconcilePullRequest(
  ctx: OrchestratorContext,
  task: Task,
): Promise<PrOutcome> {
  if (!task.githubPrNumber) return "none";
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const pr = await getPullRequest(octokit, ref, task.githubPrNumber);
  if (pr.merged) return (await finishTask(ctx, task, pr, "merged")) ? "completed" : "none";
  if (pr.state === "closed") {
    return (await finishTask(ctx, task, pr, "closed")) ? "abandoned" : "none";
  }
  if (task.status !== "PR_OPEN") return "none"; // reviews only count once the PR is up for review

  const items = await collectFeedback(ctx, task, pr);
  if (!items.length) return "none";
  const lastApproval = items.filter((i) => i.kind === "approval").at(-1);
  const feedback = items.filter((i) => i.kind === "feedback");
  const lastFeedbackAt = Math.max(0, ...feedback.map((f) => f.at));
  const newCursor = new Date(
    Math.max(
      ...items.filter((i) => i.source === "github").map((i) => i.at),
      task.reviewCursor?.getTime() ?? 0,
    ),
  );
  const sessionItems = items.filter((i) => i.source === "session");
  const newSessionCursor = sessionItems.length
    ? new Date(Math.max(...sessionItems.map((i) => i.at)))
    : task.sessionCursor;
  const markProcessed = (tx: Pick<OrchestratorContext["db"], "insert">) => {
    for (const item of items) {
      tx.insert(events)
        .values({
          githubDeliveryId: item.key,
          eventType: FEEDBACK_EVENT,
          repositoryFullName: task.repositoryId,
          payload: { taskId: task.id },
          processedAt: new Date(),
        })
        .onConflictDoNothing()
        .run();
    }
  };

  // Approved after everything else: stop and wait for the human merge.
  if (lastApproval && lastApproval.at >= lastFeedbackAt) {
    const ready = transitionTask(ctx.db, {
      taskId: task.id,
      to: "READY_FOR_HUMAN_MERGE",
      trigger: "pr_approved",
      patch: { reviewCursor: newCursor, sessionCursor: newSessionCursor },
      within: (tx) => markProcessed(tx),
    });
    await ctx.syncStatusLabel(ready);
    await createComment(
      octokit,
      ref,
      pr.number,
      "🤖 Approved. I stopped working on this — waiting for a maintainer to merge.",
    );
    return "ready";
  }

  const limit = ctx.config.file.limits.max_review_iterations;
  const round = task.iterationCount + 1;
  if (round > limit) {
    ctx.db.transaction((tx) => {
      markProcessed(tx);
      tx.update(tasks)
        .set({ reviewCursor: newCursor, sessionCursor: newSessionCursor })
        .where(eq(tasks.id, task.id))
        .run();
    });
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 I reached the limit of ${limit} automatic review rounds. Please continue in OpenCode (${sessionReference(ctx, task)}) or finish the pull request yourself.`,
    );
    return "none";
  }

  // Record the round and its feedback durably, together with the processed events.
  const feedbackText = feedback.map((f) => f.text).join("\n");
  const fromSessionOnly = feedback.every((f) => f.source === "session");
  const changes = transitionTask(ctx.db, {
    taskId: task.id,
    to: "CHANGES_REQUESTED",
    trigger: "review_changes_requested",
    patch: {
      reviewCursor: newCursor,
      sessionCursor: newSessionCursor,
      iterationCount: round,
      pendingFeedback: JSON.stringify({ round, text: feedbackText, fromSessionOnly }),
    },
    details: { round },
    within: (tx) => markProcessed(tx),
  });
  return dispatchFeedback(ctx, changes);
}

/**
 * Continues a CHANGES_REQUESTED task from its stored feedback: scope check,
 * then either a new approval in the session or an implementation round.
 * Also used to recover after a restart.
 */
export async function dispatchFeedback(ctx: OrchestratorContext, task: Task): Promise<PrOutcome> {
  if (task.status !== "CHANGES_REQUESTED" || !task.pendingFeedback) return "none";
  const { round, text, fromSessionOnly } = JSON.parse(task.pendingFeedback) as {
    round: number;
    text: string;
    fromSessionOnly: boolean;
  };
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);

  // Messages the maintainer typed in the session are their own instructions.
  // Everything else needs a successful check that it stays within the approved plan.
  let withinScope = fromSessionOnly;
  let reason = "the scope check did not give a clear answer";
  if (!fromSessionOnly && task.opencodeSessionId) {
    const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await ctx.opencode
        .generate(task.opencodeSessionId, buildScopeCheckPrompt(text), timeoutMs)
        .catch(() => "");
      const parsed = parseStructured(reply, scopeCheckSchema);
      if (parsed.ok) {
        withinScope = parsed.value.within_scope;
        reason = parsed.value.reason;
        break;
      }
    }
  }

  if (!withinScope && task.opencodeSessionId) {
    const repo = ctx.repository(task.repositoryId);
    await ctx.opencode
      .switchMode(
        task.opencodeSessionId,
        opencodeSettingsFor(ctx.config, repo).analysisAgent,
        CONVERSATION_PERMISSIONS,
      )
      .catch(() => undefined);
    await ctx.opencode.send(
      task.opencodeSessionId,
      `[maintainer service] The review feedback needs a new approval (${reason}).\n\n${text}\n\nDiscuss the plan with the maintainer; they approve it in their own words.`,
    );
    const waiting = transitionTask(ctx.db, {
      taskId: task.id,
      to: "AWAITING_APPROVAL",
      trigger: "scope_change_requested",
      patch: { pendingFeedback: null },
      details: { reason },
    });
    enqueueConversation(ctx, waiting);
    await ctx.syncStatusLabel(waiting);
    await createComment(
      octokit,
      ref,
      task.githubPrNumber!,
      `🤖 This feedback needs a new approval. Continue in OpenCode: ${sessionReference(ctx, waiting)}`,
    );
    return "scope-change";
  }

  const implementing = transitionTask(ctx.db, {
    taskId: task.id,
    to: "IMPLEMENTING",
    trigger: "implementation_started",
    details: { review: round },
  });
  enqueueImplementation(ctx, implementing, {
    taskId: implementing.id,
    review: { round, feedback: text },
  });
  await ctx.syncStatusLabel(implementing);
  return "iterating";
}

/** New, unprocessed feedback and approvals from maintainers, oldest first. */
async function collectFeedback(
  ctx: OrchestratorContext,
  task: Task,
  pr: PullRequestInfo,
): Promise<FeedbackEvent[]> {
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const maintainers = await ctx.maintainers(ref);
  const since = (task.reviewCursor?.getTime() ?? task.updatedAt.getTime()) - OVERLAP_MS;
  const isMaintainer = (u: { id: number } | null) => Boolean(u && maintainers.has(u.id));
  const items: FeedbackEvent[] = [];

  for (const r of await listReviews(octokit, ref, pr.number)) {
    if (!isMaintainer(r.user) || Date.parse(r.submittedAt) < since) continue;
    const at = Date.parse(r.submittedAt);
    if (r.state === "APPROVED") {
      items.push({
        key: `feedback:review:${r.id}`,
        at,
        kind: "approval",
        source: "github",
        text: "",
      });
    }
    if (r.state === "CHANGES_REQUESTED" || r.body.trim()) {
      items.push({
        key: `feedback:review-body:${r.id}`,
        at,
        kind: "feedback",
        source: "github",
        text: `- @${r.user?.login} (review): ${r.body.trim() || "(see inline comments)"}`,
      });
    }
  }
  for (const c of await listReviewComments(octokit, ref, pr.number)) {
    if (!isMaintainer(c.user) || Date.parse(c.createdAt) < since) continue;
    items.push({
      key: `feedback:inline:${c.id}`,
      at: Date.parse(c.createdAt),
      kind: "feedback",
      source: "github",
      text: `- @${c.user?.login} on \`${c.path}${c.line ? `:${c.line}` : ""}\`: ${c.body.trim()}`,
    });
  }
  for (const c of await listIssueComments(octokit, ref, pr.number)) {
    if (
      !isMaintainer(c.user) ||
      Date.parse(c.createdAt) < since ||
      c.body.trim().startsWith("/ai")
    ) {
      continue;
    }
    items.push({
      key: `feedback:comment:${c.id}`,
      at: Date.parse(c.createdAt),
      kind: "feedback",
      source: "github",
      text: `- @${c.user?.login}: ${c.body.trim()}`,
    });
  }
  if (task.opencodeSessionId) {
    for (const m of await ctx.opencode.messages(task.opencodeSessionId)) {
      // Session messages count only after the session cursor (the approval itself is not feedback).
      if (m.kind !== "human" || m.created <= (task.sessionCursor?.getTime() ?? 0)) continue;
      items.push({
        key: `feedback:session:${m.id}`,
        at: m.created,
        kind: "feedback",
        source: "session",
        text: `- Maintainer in the session: ${m.text.trim()}`,
      });
    }
  }

  const keys = items.map((i) => i.key);
  const processed = new Set(
    keys.length
      ? ctx.db
          .select({ key: events.githubDeliveryId })
          .from(events)
          .where(inArray(events.githubDeliveryId, keys))
          .all()
          .map((e) => e.key)
      : [],
  );
  return items.filter((i) => !processed.has(i.key)).sort((a, b) => a.at - b.at);
}

/** Merged or closed: final state, then cleanup (retried on later syncs if it fails). */
export async function finishTask(
  ctx: OrchestratorContext,
  task: Task,
  pr: PullRequestInfo,
  how: "merged" | "closed",
): Promise<boolean> {
  const to = how === "merged" ? "COMPLETED" : "ABANDONED";
  const trigger = how === "merged" ? "pr_merged" : "pr_closed_unmerged";
  if (!canTransition(task.status, to, trigger)) return false;
  const done = transitionTask(ctx.db, { taskId: task.id, to, trigger, details: { pr: pr.number } });
  releaseLock(ctx.db, repoLockName(task.repositoryId), taskLockOwner(task.id));
  ctx.audit({
    action: `task.${how}`,
    repositoryId: task.repositoryId,
    taskId: task.id,
    details: { pr: pr.number },
  });
  if (how === "closed") {
    const ref = ctx.ref(ctx.repository(task.repositoryId));
    const octokit = await ctx.github.octokitFor(ref);
    await createComment(
      octokit,
      ref,
      task.githubIssueNumber,
      `🤖 Pull request #${pr.number} was closed without merging, so I stopped. Add \`${ctx.config.file.github.allowed_label}\` again to start over.`,
    ).catch(() => undefined);
  }
  await cleanupTask(ctx, done).catch((err: unknown) =>
    ctx.logger.warn({ taskId: task.id, err: (err as Error).message }, "cleanup failed; will retry"),
  );
  return true;
}

/**
 * Idempotent cleanup of a finished task: lock, worktree, allowed label (so the
 * issue does not restart by itself), status label, session title. Marks the
 * task cleaned only when everything succeeded.
 */
export async function cleanupTask(ctx: OrchestratorContext, task: Task): Promise<void> {
  if (task.cleanedAt || (task.status !== "COMPLETED" && task.status !== "ABANDONED")) return;
  releaseLock(ctx.db, repoLockName(task.repositoryId), taskLockOwner(task.id));
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  if (task.branchName) {
    await ctx.workspace.removeWorktree(ctx.workspaceRepo(repo), {
      taskKey: taskKey(task),
      branch: branchFor(task),
    });
  }
  await removeLabel(octokit, ref, task.githubIssueNumber, ctx.config.file.github.allowed_label);
  await ctx.syncStatusLabel(task);
  if (task.opencodeSessionId) {
    await ctx.opencode
      .rename(
        task.opencodeSessionId,
        `${task.status === "COMPLETED" ? "✅" : "⛔"} ${repo.id}#${task.githubIssueNumber}`,
      )
      .catch(() => undefined); // cosmetic
  }
  ctx.db.update(tasks).set({ cleanedAt: new Date() }).where(eq(tasks.id, task.id)).run();
}

/** Retries cleanups that failed earlier (called on every sync). Returns the issues cleaned now. */
export async function retryCleanups(
  ctx: OrchestratorContext,
  repositoryId: string,
): Promise<number[]> {
  const pending = ctx.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.repositoryId, repositoryId),
        inArray(tasks.status, ["COMPLETED", "ABANDONED"]),
        isNull(tasks.cleanedAt),
      ),
    )
    .all();
  const cleaned: number[] = [];
  for (const task of pending) {
    try {
      await cleanupTask(ctx, task);
      cleaned.push(task.githubIssueNumber);
    } catch (err) {
      ctx.logger.warn(
        { taskId: task.id, err: (err as Error).message },
        "cleanup failed; will retry",
      );
    }
  }
  return cleaned;
}
