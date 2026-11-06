import { and, eq, isNull } from "drizzle-orm";
import { decisions, events, proposals } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, type IssueComment } from "../github/issues.js";
import { enqueue } from "../workers/queue.js";
import { ANALYZE_JOB, analyzeDedupeKey } from "./analysis.js";
import { COMMAND_HELP, parseCommand, type Command } from "./commands.js";
import type { OrchestratorContext, ProposalRow, Task } from "./context.js";
import { isImplementable, type Proposal } from "./proposal.js";

const COMMAND_EVENT = "issue_comment.command";
type Decision = typeof decisions.$inferSelect;

/**
 * Handles one `/ai` command comment. Returns false when the comment is not a
 * command or was already handled completely.
 *
 * Recoverable by design: the command is recorded first; state changes are
 * committed atomically together with their decision row; GitHub side effects
 * (labels, reply) come last and the event is marked processed only after them.
 * If anything fails, the next poll resumes the same command, and a decision
 * that was already applied is never applied twice.
 */
export async function handleCommandComment(
  ctx: OrchestratorContext,
  repositoryId: string,
  comment: IssueComment,
): Promise<boolean> {
  const command = parseCommand(comment.body);
  if (!command || !comment.user) return false;

  const deliveryId = `comment:${comment.id}`;
  ctx.db
    .insert(events)
    .values({
      githubDeliveryId: deliveryId,
      eventType: COMMAND_EVENT,
      action: command.kind,
      repositoryFullName: repositoryId,
      payload: { comment },
    })
    .onConflictDoNothing()
    .run();
  const event = ctx.db.select().from(events).where(eq(events.githubDeliveryId, deliveryId)).get()!;
  if (event.processedAt) return false;

  await processCommand(ctx, repositoryId, { ...comment, user: comment.user }, command);
  ctx.db.update(events).set({ processedAt: new Date() }).where(eq(events.id, event.id)).run();
  return true;
}

/** Commands recorded earlier whose handling did not finish (resumed on the next poll). */
export function unfinishedCommands(ctx: OrchestratorContext, repositoryId: string): IssueComment[] {
  return ctx.db
    .select()
    .from(events)
    .where(
      and(
        eq(events.eventType, COMMAND_EVENT),
        eq(events.repositoryFullName, repositoryId),
        isNull(events.processedAt),
      ),
    )
    .all()
    .map((e) => (e.payload as { comment: IssueComment }).comment);
}

async function processCommand(
  ctx: OrchestratorContext,
  repositoryId: string,
  comment: IssueComment & { user: NonNullable<IssueComment["user"]> },
  command: Command,
): Promise<void> {
  const repo = ctx.repository(repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const reply = async (text: string) => {
    await createComment(
      octokit,
      ref,
      comment.issueNumber,
      `> ${comment.body.split("\n")[0]!.slice(0, 120)}\n\n${text}`,
    );
  };

  const maintainers = await ctx.maintainers(ref);
  if (!maintainers.has(comment.user.id)) {
    // Never act on, and never answer, commands from non-maintainers.
    ctx.audit({
      action: "command.unauthorized",
      repositoryId,
      actor: comment.user.login,
      details: { commentId: comment.id, issue: comment.issueNumber, command: command.kind },
    });
    return;
  }
  const actor = comment.user.login;

  // Resuming after a failure: the decision is already applied, only finish the side effects.
  const applied = ctx.db
    .select()
    .from(decisions)
    .where(eq(decisions.githubCommentId, comment.id))
    .get();
  if (applied) {
    await finishDecision(ctx, applied, reply);
    return;
  }

  if (command.kind === "invalid") {
    await reply(`🤖 ${command.reason}. ${COMMAND_HELP}`);
    return;
  }

  const task = ctx.liveTask(repositoryId, comment.issueNumber);
  if (!task) {
    await reply(
      `🤖 There is no AI task for this issue. A maintainer must add the \`${ctx.config.file.github.allowed_label}\` label first.`,
    );
    return;
  }

  const latest = ctx.latestProposal(task.id);
  const staleReason = staleness(comment, latest);
  const decisionRow = (decision: Decision["decision"], instructions?: string) => ({
    taskId: task.id,
    proposalVersion: latest?.version ?? 0,
    decision,
    githubUser: actor,
    githubUserId: comment.user.id,
    githubCommentId: comment.id,
    instructions: instructions ?? null,
  });

  switch (command.kind) {
    case "approve": {
      if (task.status === "APPROVED") {
        await reply(`🤖 Proposal v${task.approvedVersion ?? "?"} is already approved.`);
        return;
      }
      if (task.status !== "AWAITING_APPROVAL" || !latest) {
        await reply(`🤖 Nothing to approve: the task is ${describe(task)}.`);
        return;
      }
      if (staleReason) {
        await reply(`🤖 ${staleReason} Please review v${latest.version} and approve again.`);
        return;
      }
      if (!isImplementable(latest.content as Proposal)) {
        await reply(
          "🤖 This proposal is not implementable as it stands (the issue is marked invalid or there is no plan). " +
            "Update the issue or use `/ai revise <guidance>`.",
        );
        return;
      }
      transitionTask(ctx.db, {
        taskId: task.id,
        to: "APPROVED",
        trigger: "approve_command",
        actor,
        patch: { approvedVersion: latest.version },
        details: { version: latest.version, commentId: comment.id },
        within: (tx) => {
          tx.insert(decisions).values(decisionRow("approve")).run();
          tx.update(proposals).set({ status: "approved" }).where(eq(proposals.id, latest.id)).run();
        },
      });
      break;
    }
    case "reject": {
      if (task.status !== "AWAITING_APPROVAL" || !latest) {
        await reply(`🤖 Nothing to reject: the task is ${describe(task)}.`);
        return;
      }
      if (staleReason) {
        await reply(`🤖 ${staleReason} Please review v${latest.version} and reply again.`);
        return;
      }
      transitionTask(ctx.db, {
        taskId: task.id,
        to: "REJECTED",
        trigger: "reject_command",
        actor,
        details: { version: latest.version, commentId: comment.id },
        within: (tx) => {
          tx.insert(decisions).values(decisionRow("reject")).run();
          tx.update(proposals).set({ status: "rejected" }).where(eq(proposals.id, latest.id)).run();
        },
      });
      break;
    }
    case "revise": {
      if (!["AWAITING_APPROVAL", "REJECTED", "APPROVED", "FAILED"].includes(task.status)) {
        await reply(`🤖 Cannot revise now: the task is ${describe(task)}.`);
        return;
      }
      if (staleReason) {
        await reply(
          `🤖 ${staleReason} Please review v${latest!.version} and send your guidance again.`,
        );
        return;
      }
      // The revision instructions live in the decision row; the analysis reads them from there.
      transitionTask(ctx.db, {
        taskId: task.id,
        to: "ANALYZING",
        trigger: task.status === "FAILED" ? "manual_retry" : "revise_command",
        actor,
        patch: { approvedVersion: null },
        details: { commentId: comment.id },
        within: (tx) => {
          tx.insert(decisions).values(decisionRow("revise", command.instructions)).run();
        },
      });
      break;
    }
  }
  const decision = ctx.db
    .select()
    .from(decisions)
    .where(eq(decisions.githubCommentId, comment.id))
    .get()!;
  await finishDecision(ctx, decision, reply);
}

/**
 * Why a command does not refer to the proposal the maintainer could have seen,
 * or null. Uses GitHub's own timestamps for both sides (same clock, second
 * precision); a comment in the same second as the publication is too early to
 * have been a response to it.
 */
export function staleness(
  comment: Pick<IssueComment, "createdAt">,
  latest: ProposalRow | undefined,
): string | null {
  if (!latest) return null;
  if (!latest.publishedAt) {
    return `Proposal v${latest.version} is still being published.`;
  }
  if (Date.parse(comment.createdAt) <= latest.publishedAt.getTime()) {
    return `The proposal changed (now v${latest.version}) after this comment was written.`;
  }
  return null;
}

/** GitHub side effects of an applied decision; safe to repeat. */
async function finishDecision(
  ctx: OrchestratorContext,
  decision: Decision,
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const task = ctx.task(decision.taskId)!;
  const by = `@${decision.githubUser}`;
  // The label follows the task's current state (which may have moved on since).
  await ctx.syncStatusLabel(task);
  switch (decision.decision) {
    case "approve":
      await reply(
        `🤖 Proposal v${decision.proposalVersion} approved by ${by}. It is queued for implementation.`,
      );
      break;
    case "reject":
      await reply(
        `🤖 Proposal v${decision.proposalVersion} rejected by ${by}. Nothing will be implemented.`,
      );
      break;
    case "revise":
      enqueue(ctx.db, {
        type: ANALYZE_JOB,
        payload: { taskId: task.id },
        repositoryId: task.repositoryId,
        dedupeKey: analyzeDedupeKey(task.id),
        maxAttempts: 3,
      });
      await reply(`🤖 Revision requested by ${by}. A new proposal version will follow.`);
      break;
  }
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
