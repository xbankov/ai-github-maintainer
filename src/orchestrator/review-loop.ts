import { eq } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { releaseLock, repoLockName, taskLockOwner } from "../database/locks.js";
import { tasks } from "../database/schema.js";
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

/**
 * Reconciles one task with its pull request (called on every sync):
 * merged → COMPLETED, closed → ABANDONED, maintainer approval → stop and wait
 * for the human merge, maintainer feedback → another round in the session.
 * The bot never merges and never reopens a closed pull request.
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
  if (pr.state === "closed")
    return (await finishTask(ctx, task, pr, "closed")) ? "abandoned" : "none";
  if (task.status !== "PR_OPEN") return "none"; // reviews only count once the PR is up for review

  // Feedback from maintainers since the last processed point.
  const maintainers = await ctx.maintainers(ref);
  const cursor = task.reviewCursor?.getTime() ?? task.updatedAt.getTime();
  const after = (iso: string) => Date.parse(iso) > cursor;
  const isMaintainer = (u: { id: number } | null) => Boolean(u && maintainers.has(u.id));
  const reviews = (await listReviews(octokit, ref, pr.number)).filter(
    (r) => after(r.submittedAt) && isMaintainer(r.user),
  );
  const inline = (await listReviewComments(octokit, ref, pr.number)).filter(
    (c) => after(c.createdAt) && isMaintainer(c.user),
  );
  const conversation = (await listIssueComments(octokit, ref, pr.number)).filter(
    (c) => after(c.createdAt) && isMaintainer(c.user) && !c.body.trim().startsWith("/ai"),
  );
  const session = task.opencodeSessionId
    ? (await ctx.opencode.messages(task.opencodeSessionId)).filter(
        (m) => m.kind === "human" && m.created > (task.sessionCursor?.getTime() ?? 0),
      )
    : [];
  const times = [
    ...reviews.map((r) => Date.parse(r.submittedAt)),
    ...inline.map((c) => Date.parse(c.createdAt)),
    ...conversation.map((c) => Date.parse(c.createdAt)),
  ];
  const newCursor = times.length ? new Date(Math.max(...times)) : task.reviewCursor;
  const newSessionCursor = session.length ? new Date(session.at(-1)!.created) : task.sessionCursor;
  const saveCursors = () =>
    ctx.db
      .update(tasks)
      .set({ reviewCursor: newCursor, sessionCursor: newSessionCursor })
      .where(eq(tasks.id, task.id))
      .run();

  // A maintainer approved the PR (and did not ask for changes afterwards): stop.
  const lastReview = reviews.at(-1);
  if (
    lastReview?.state === "APPROVED" &&
    !inline.some((c) => Date.parse(c.createdAt) > Date.parse(lastReview.submittedAt))
  ) {
    const ready = transitionTask(ctx.db, {
      taskId: task.id,
      to: "READY_FOR_HUMAN_MERGE",
      trigger: "pr_approved",
      actor: lastReview.user?.login,
      patch: { reviewCursor: newCursor },
    });
    await ctx.syncStatusLabel(ready);
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 Approved by @${lastReview.user?.login}. I stopped working on this — waiting for a maintainer to merge.`,
    );
    return "ready";
  }

  const feedback = [
    ...reviews
      .filter((r) => r.state === "CHANGES_REQUESTED" || r.body.trim())
      .map(
        (r) =>
          `- @${r.user?.login} (review, ${r.state.toLowerCase().replace("_", " ")}): ${r.body.trim() || "(see inline comments)"}`,
      ),
    ...inline.map(
      (c) => `- @${c.user?.login} on \`${c.path}${c.line ? `:${c.line}` : ""}\`: ${c.body.trim()}`,
    ),
    ...conversation.map((c) => `- @${c.user?.login}: ${c.body.trim()}`),
    ...(session.length
      ? ["- The maintainer also wrote new messages in this session; address them too."]
      : []),
  ];
  if (!feedback.length) {
    saveCursors();
    return "none";
  }

  const limit = ctx.config.file.limits.max_review_iterations;
  const round = task.iterationCount + 1;
  if (round > limit) {
    saveCursors();
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 I reached the limit of ${limit} automatic review rounds. Please continue in OpenCode (${sessionReference(ctx, task)}) or finish the pull request yourself.`,
    );
    return "none";
  }

  const feedbackText = feedback.join("\n");
  const changes = transitionTask(ctx.db, {
    taskId: task.id,
    to: "CHANGES_REQUESTED",
    trigger: "review_changes_requested",
    patch: { reviewCursor: newCursor, sessionCursor: newSessionCursor, iterationCount: round },
    details: { round },
  });

  // Does the feedback fit the approved plan? (Messages typed in the session are trusted as-is.)
  let withinScope = true;
  let reason = "";
  if (changes.opencodeSessionId && feedback.some((f) => !f.includes("in this session"))) {
    const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
    const reply = await ctx.opencode
      .generate(changes.opencodeSessionId, buildScopeCheckPrompt(feedbackText), timeoutMs)
      .catch(() => "");
    const parsed = parseStructured(reply, scopeCheckSchema);
    if (parsed.ok) {
      withinScope = parsed.value.within_scope;
      reason = parsed.value.reason;
    }
  }

  if (!withinScope && changes.opencodeSessionId) {
    const repo = ctx.repository(changes.repositoryId);
    await ctx.opencode
      .switchMode(
        changes.opencodeSessionId,
        opencodeSettingsFor(ctx.config, repo).analysisAgent,
        CONVERSATION_PERMISSIONS,
      )
      .catch(() => undefined);
    await ctx.opencode.send(
      changes.opencodeSessionId,
      `[maintainer service] The review feedback goes beyond the approved plan (${reason}).\n\n${feedbackText}\n\nDiscuss the new plan with the maintainer; they approve it in their own words.`,
    );
    const waiting = transitionTask(ctx.db, {
      taskId: changes.id,
      to: "AWAITING_APPROVAL",
      trigger: "scope_change_requested",
      details: { reason },
    });
    enqueueConversation(ctx, waiting);
    await ctx.syncStatusLabel(waiting);
    await createComment(
      octokit,
      ref,
      pr.number,
      `🤖 This feedback changes the approved scope, so it needs a new approval. Continue in OpenCode: ${sessionReference(ctx, waiting)}`,
    );
    return "scope-change";
  }

  const implementing = transitionTask(ctx.db, {
    taskId: changes.id,
    to: "IMPLEMENTING",
    trigger: "implementation_started",
    details: { review: round },
  });
  enqueueImplementation(ctx, implementing, {
    taskId: implementing.id,
    review: { round, feedback: feedbackText },
  });
  await ctx.syncStatusLabel(implementing);
  return "iterating";
}

/** Merged or closed: final state, free the repository, clean up. Idempotent. */
export async function finishTask(
  ctx: OrchestratorContext,
  task: Task,
  pr: PullRequestInfo,
  how: "merged" | "closed",
): Promise<boolean> {
  const to = how === "merged" ? "COMPLETED" : "ABANDONED";
  const trigger = how === "merged" ? "pr_merged" : "pr_closed_unmerged";
  if (!canTransition(task.status, to, trigger)) return false;
  const done = transitionTask(ctx.db, {
    taskId: task.id,
    to,
    trigger,
    details: { pr: pr.number },
  });
  releaseLock(ctx.db, repoLockName(task.repositoryId), taskLockOwner(task.id));
  const repo = ctx.repository(task.repositoryId);
  await ctx.workspace
    .removeWorktree(ctx.workspaceRepo(repo), { taskKey: taskKey(task), branch: branchFor(task) })
    .catch(() => undefined);
  await ctx.syncStatusLabel(done).catch(() => undefined);
  if (task.opencodeSessionId) {
    await ctx.opencode
      .rename(
        task.opencodeSessionId,
        `${how === "merged" ? "✅" : "⛔"} ${repo.id}#${task.githubIssueNumber}`,
      )
      .catch(() => undefined);
  }
  // Remove the allowed label, so the finished issue is not picked up again by itself.
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  await removeLabel(octokit, ref, task.githubIssueNumber, ctx.config.file.github.allowed_label);
  if (how === "closed") {
    await createComment(
      octokit,
      ref,
      task.githubIssueNumber,
      `🤖 Pull request #${pr.number} was closed without merging, so I stopped. Add \`${ctx.config.file.github.allowed_label}\` again to start over.`,
    );
  }
  ctx.audit({
    action: `task.${how}`,
    repositoryId: task.repositoryId,
    taskId: task.id,
    details: { pr: pr.number },
  });
  return true;
}
