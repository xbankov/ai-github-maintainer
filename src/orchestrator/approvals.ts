import { eq } from "drizzle-orm";
import { events } from "../database/schema.js";
import { createComment, type IssueComment } from "../github/issues.js";
import { parseCommand } from "./commands.js";
import { sessionReference } from "./conversation.js";
import type { OrchestratorContext } from "./context.js";

const COMMAND_EVENT = "issue_comment.command";

/**
 * Decisions are made in the issue's OpenCode session, not on GitHub. A
 * maintainer who writes an `/ai` command on GitHub gets one reply with the
 * session link. Commands from others are ignored. Each comment is handled once.
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

  const ref = ctx.ref(ctx.repository(repositoryId));
  if ((await ctx.maintainers(ref)).has(comment.user.id)) {
    const task = ctx.liveTask(repositoryId, comment.issueNumber);
    const octokit = await ctx.github.octokitFor(ref);
    await createComment(
      octokit,
      ref,
      comment.issueNumber,
      task?.opencodeSessionId
        ? `🤖 Decisions are made in the OpenCode session: ${sessionReference(ctx, task)}`
        : `🤖 Add the \`${ctx.config.file.github.allowed_label}\` label to start; the discussion then happens in OpenCode.`,
    );
  } else {
    ctx.audit({
      action: "command.ignored",
      repositoryId,
      actor: comment.user.login,
      details: { commentId: comment.id, issue: comment.issueNumber },
    });
  }
  ctx.db.update(events).set({ processedAt: new Date() }).where(eq(events.id, event.id)).run();
  return true;
}

/** Commands recorded earlier whose handling did not finish (resumed on the next poll). */
export function unfinishedCommands(ctx: OrchestratorContext, repositoryId: string): IssueComment[] {
  return ctx.db
    .select()
    .from(events)
    .where(eq(events.repositoryFullName, repositoryId))
    .all()
    .filter((e) => e.eventType === COMMAND_EVENT && !e.processedAt)
    .map((e) => (e.payload as { comment: IssueComment }).comment);
}
