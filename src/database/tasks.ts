import { and, eq } from "drizzle-orm";
import {
  assertTransition,
  TERMINAL_STATES,
  type TaskState,
  type TransitionTrigger,
} from "../orchestrator/state-machine.js";
import type { Db } from "./client.js";

/** A Drizzle transaction on the application database. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
import { auditLog, tasks } from "./schema.js";

export class TaskNotFoundError extends Error {
  override name = "TaskNotFoundError";
}

/** Thrown when the task changed concurrently between read and write. */
export class StaleTaskError extends Error {
  override name = "StaleTaskError";
}

export type TaskPatch = Partial<
  Pick<
    typeof tasks.$inferInsert,
    | "githubPrNumber"
    | "proposalVersion"
    | "approvedVersion"
    | "opencodeSessionId"
    | "sessionCursor"
    | "reviewCursor"
    | "pendingFeedback"
    | "cleanedAt"
    | "inputNotifiedAt"
    | "branchName"
    | "iterationCount"
    | "ciAttempts"
    | "issueFingerprint"
    | "lastError"
  >
>;

export interface TransitionInput {
  taskId: number;
  to: TaskState;
  trigger: TransitionTrigger;
  actor?: string;
  /** Extra columns updated atomically with the status. */
  patch?: TaskPatch;
  details?: Record<string, unknown>;
  /**
   * Extra writes committed atomically with the transition (e.g. the decision or
   * proposal that justifies it). Runs after the status update succeeded.
   */
  within?: (tx: Tx, updated: typeof tasks.$inferSelect) => void;
}

/**
 * The only way to change a task's status. Validates the transition, applies it
 * with an optimistic check on the current status and records it in the audit log,
 * all in one transaction.
 */
export function transitionTask(db: Db, input: TransitionInput): typeof tasks.$inferSelect {
  return db.transaction((tx) => {
    const current = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
    if (!current) throw new TaskNotFoundError(`Task ${input.taskId} not found`);
    assertTransition(current.status, input.to, input.trigger);

    const updated = tx
      .update(tasks)
      .set({
        ...input.patch,
        status: input.to,
        completedAt: TERMINAL_STATES.has(input.to) ? new Date() : null,
      })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.status, current.status)))
      .returning()
      .get();
    if (!updated) throw new StaleTaskError(`Task ${input.taskId} changed concurrently`);
    input.within?.(tx, updated);

    tx.insert(auditLog)
      .values({
        repositoryId: current.repositoryId,
        taskId: current.id,
        action: "task.transition",
        actor: input.actor ?? "system",
        details: { from: current.status, to: input.to, trigger: input.trigger, ...input.details },
      })
      .run();
    return updated;
  });
}
