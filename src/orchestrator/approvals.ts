import { eq } from "drizzle-orm";
import { decisions, events, proposals } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, getIssue, setStatusLabel, type IssueComment } from "../github/issues.js";
import { enqueue } from "../workers/queue.js";
import { ANALYZE_JOB, analyzeDedupeKey, type AnalyzePayload } from "./analysis.js";
import { COMMAND_HELP, parseCommand } from "./commands.js";
import type { OrchestratorContext, Task } from "./context.js";
import { isImplementable, type Proposal } from "./proposal.js";

/**
 * Handles one `/ai` command comment. Returns false when the comment is not a
 * command (or was already handled). Every decision is persisted; approval is
 * bound to the proposal version that was current when the comment was written.
 */
export async function handleCommandComment(
  ctx: OrchestratorContext,
  repositoryId: string,
  comment: IssueComment,
): Promise<boolean> {
  const command = parseCommand(comment.body);
  if (!command || !comment.user) return false;

  // Idempotency: each comment is handled at most once.
  const deliveryId = `comment:${comment.id}`;
  const inserted = ctx.db
    .insert(events)
    .values({
      githubDeliveryId: deliveryId,
      eventType: "issue_comment.command",
      action: command.kind,
      repositoryFullName: repositoryId,
      payload: {
        commentId: comment.id,
        issue: comment.issueNumber,
        user: comment.user.login,
        userId: comment.user.id,
        body: comment.body.slice(0, 500),
        createdAt: comment.createdAt,
      },
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!inserted) return false;

  const repo = ctx.repository(repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const reply = (text: string) =>
    createComment(
      octokit,
      ref,
      comment.issueNumber,
      `> ${comment.body.split("\n")[0]!.slice(0, 120)}\n\n${text}`,
    );
  const markDone = () =>
    ctx.db.update(events).set({ processedAt: new Date() }).where(eq(events.id, inserted.id)).run();

  const maintainers = await ctx.maintainers();
  if (!maintainers.has(comment.user.id)) {
    // Never act on, and never answer, commands from non-maintainers.
    ctx.audit({
      action: "command.unauthorized",
      repositoryId,
      actor: comment.user.login,
      details: { commentId: comment.id, issue: comment.issueNumber, command: command.kind },
    });
    markDone();
    return true;
  }
  const actor = comment.user.login;

  if (command.kind === "invalid") {
    await reply(`🤖 ${command.reason}. ${COMMAND_HELP}`);
    markDone();
    return true;
  }

  const task = ctx.liveTask(repositoryId, comment.issueNumber);
  if (!task) {
    await reply(
      `🤖 There is no AI task for this issue. A maintainer must add the \`${ctx.config.file.github.allowed_label}\` label first.`,
    );
    markDone();
    return true;
  }

  const latest = ctx.latestProposal(task.id);
  const record = (decision: "approve" | "reject" | "revise", instructions?: string) =>
    ctx.db
      .insert(decisions)
      .values({
        taskId: task.id,
        proposalVersion: latest?.version ?? 0,
        decision,
        githubUser: actor,
        githubUserId: comment.user!.id,
        githubCommentId: comment.id,
        instructions: instructions ?? null,
      })
      .run();
  // The comment must have been written after the version it refers to was published.
  const stale = Boolean(latest && new Date(comment.createdAt) < latest.createdAt);

  switch (command.kind) {
    case "approve":
      await approve(ctx, task, latest, stale, actor, reply, record);
      break;
    case "reject":
      if (task.status !== "AWAITING_APPROVAL" || !latest) {
        await reply(`🤖 Nothing to reject: the task is ${describe(task)}.`);
        break;
      }
      if (stale) {
        await reply(
          `🤖 The proposal changed (now v${latest.version}) after this comment. Please review it and reply again.`,
        );
        break;
      }
      record("reject");
      ctx.db.update(proposals).set({ status: "rejected" }).where(eq(proposals.id, latest.id)).run();
      transitionTask(ctx.db, { taskId: task.id, to: "REJECTED", trigger: "reject_command", actor });
      await clearStatus(ctx, task);
      await reply(
        `🤖 Proposal v${latest.version} rejected by @${actor}. Nothing will be implemented.`,
      );
      break;
    case "revise": {
      const trigger = task.status === "FAILED" ? "manual_retry" : "revise_command";
      if (!["AWAITING_APPROVAL", "REJECTED", "APPROVED", "FAILED"].includes(task.status)) {
        await reply(`🤖 Cannot revise now: the task is ${describe(task)}.`);
        break;
      }
      record("revise", command.instructions);
      transitionTask(ctx.db, {
        taskId: task.id,
        to: "ANALYZING",
        trigger,
        actor,
        patch: { approvedVersion: null },
      });
      const payload: AnalyzePayload = {
        taskId: task.id,
        revision: { instructions: command.instructions, by: actor },
      };
      enqueue(ctx.db, {
        type: ANALYZE_JOB,
        payload: { ...payload },
        repositoryId,
        dedupeKey: analyzeDedupeKey(task.id),
        maxAttempts: 3,
      });
      await reply(`🤖 Revision requested by @${actor}. A new proposal version will follow.`);
      break;
    }
  }
  markDone();
  return true;
}

async function approve(
  ctx: OrchestratorContext,
  task: Task,
  latest: ReturnType<OrchestratorContext["latestProposal"]>,
  stale: boolean,
  actor: string,
  reply: (text: string) => Promise<number>,
  record: (d: "approve") => void,
) {
  if (task.status === "APPROVED") {
    await reply(`🤖 Proposal v${task.approvedVersion ?? "?"} is already approved.`);
    return;
  }
  if (task.status !== "AWAITING_APPROVAL" || !latest) {
    await reply(`🤖 Nothing to approve: the task is ${describe(task)}.`);
    return;
  }
  if (stale) {
    await reply(
      `🤖 The proposal changed (now v${latest.version}) after this comment. Please review v${latest.version} and approve again.`,
    );
    return;
  }
  if (!isImplementable(latest.content as Proposal)) {
    await reply(
      "🤖 This proposal is not implementable as it stands (the issue is marked invalid or there is no plan). " +
        "Update the issue or use `/ai revise <guidance>`.",
    );
    return;
  }
  record("approve");
  ctx.db.update(proposals).set({ status: "approved" }).where(eq(proposals.id, latest.id)).run();
  transitionTask(ctx.db, {
    taskId: task.id,
    to: "APPROVED",
    trigger: "approve_command",
    actor,
    patch: { approvedVersion: latest.version },
    details: { version: latest.version },
  });
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, "queued");
  await reply(
    `🤖 Proposal v${latest.version} approved by @${actor}. It is queued for implementation.`,
  );
}

async function clearStatus(ctx: OrchestratorContext, task: Task) {
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, null);
}

function describe(task: Task): string {
  switch (task.status) {
    case "DISCOVERED":
    case "ANALYZING":
      return "still being analysed — wait for the proposal";
    case "REJECTED":
      return "rejected (use `/ai revise <guidance>` to re-analyse)";
    case "FAILED":
      return "failed (use `/ai revise <guidance>` to retry)";
    default:
      return task.status.toLowerCase().replace(/_/g, " ");
  }
}
