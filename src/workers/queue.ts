import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../database/client.js";
import { jobs } from "../database/schema.js";

/**
 * Durable SQLite job queue (SPEC §4 "Worker Queue").
 *
 * - Jobs are persisted before anything is acknowledged.
 * - `dedupeKey` allows at most one pending/running job per key (idempotency).
 * - Claiming is atomic and never starts a second job for a repository that
 *   already has one running (per-repository serialisation).
 * - Failures retry with exponential backoff up to `maxAttempts`, then go `dead`.
 * - Jobs left `running` by a crash are returned to `pending` on start-up.
 */

export type Job = typeof jobs.$inferSelect;

export interface EnqueueInput {
  type: string;
  payload: Record<string, unknown>;
  repositoryId?: string | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
  /** Earliest execution time (default: now). */
  availableAt?: Date;
}

export interface EnqueueResult {
  job: Job;
  /** false when an active job with the same dedupe key already existed. */
  created: boolean;
}

export function enqueue(db: Db, input: EnqueueInput): EnqueueResult {
  return db.transaction((tx) => {
    if (input.dedupeKey) {
      const existing = tx
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ["pending", "running"])),
        )
        .get();
      if (existing) return { job: existing, created: false };
    }
    const job = tx
      .insert(jobs)
      .values({
        type: input.type,
        payload: input.payload,
        repositoryId: input.repositoryId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        maxAttempts: input.maxAttempts ?? 5,
        availableAt: input.availableAt ?? new Date(),
      })
      .returning()
      .get();
    return { job, created: true };
  });
}

/**
 * Claims the next runnable job, or returns undefined.
 * A job is runnable when it is pending, due, and no other job for the same
 * repository is running.
 */
export function claimNext(db: Db, workerId: string, now = new Date()): Job | undefined {
  return db.transaction((tx) => {
    const busyRepos = tx
      .select({ id: jobs.repositoryId })
      .from(jobs)
      .where(and(eq(jobs.status, "running"), sql`${jobs.repositoryId} is not null`))
      .all()
      .map((r) => r.id as string);
    const candidate = tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.availableAt, now),
          busyRepos.length
            ? or(isNull(jobs.repositoryId), notInArray(jobs.repositoryId, busyRepos))
            : undefined,
        ),
      )
      .orderBy(asc(jobs.availableAt), asc(jobs.id))
      .limit(1)
      .get();
    if (!candidate) return undefined;
    return tx
      .update(jobs)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        lockedAt: now,
        lockedBy: workerId,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "pending")))
      .returning()
      .get();
  });
}

export function completeJob(db: Db, id: number): void {
  db.update(jobs)
    .set({ status: "succeeded", lockedAt: null, lockedBy: null, lastError: null })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
}

/** Delay before retry n (1-based): 30 s, 1 min, 2 min, … capped at 1 h. */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 3_600_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface FailResult {
  /** True when the job will not be retried. */
  dead: boolean;
  retryAt?: Date;
}

/** Records a failure; schedules a retry or marks the job dead. */
export function failJob(
  db: Db,
  job: Pick<Job, "id" | "attempts" | "maxAttempts">,
  error: string,
  options: { permanent?: boolean; now?: Date } = {},
): FailResult {
  const now = options.now ?? new Date();
  const dead = options.permanent === true || job.attempts >= job.maxAttempts;
  const retryAt = dead ? undefined : new Date(now.getTime() + backoffMs(job.attempts));
  db.update(jobs)
    .set({
      status: dead ? "dead" : "pending",
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 4000),
      ...(retryAt ? { availableAt: retryAt } : {}),
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
    .run();
  return { dead, retryAt };
}

/**
 * Puts a running job back to pending for a later check without counting the
 * attempt (used for polling, e.g. waiting for CI).
 */
export function deferJob(
  db: Db,
  job: Pick<Job, "id" | "attempts">,
  delayMs: number,
  now = new Date(),
): Date {
  const availableAt = new Date(now.getTime() + delayMs);
  db.update(jobs)
    .set({
      status: "pending",
      attempts: Math.max(0, job.attempts - 1),
      lockedAt: null,
      lockedBy: null,
      availableAt,
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
    .run();
  return availableAt;
}

/**
 * Returns running jobs whose lease is older than `staleBefore` to pending.
 * At start-up pass `new Date()`: nothing can still be running after a restart.
 */
export function recoverStaleJobs(db: Db, staleBefore: Date): number {
  return db
    .update(jobs)
    .set({ status: "pending", lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, staleBefore)))
    .run().changes;
}

export function hasActiveJob(db: Db, dedupeKey: string): boolean {
  return Boolean(
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, dedupeKey), inArray(jobs.status, ["pending", "running"])))
      .get(),
  );
}
