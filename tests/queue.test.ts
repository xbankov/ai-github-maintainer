import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/database/client.js";
import { syncRepositories } from "../src/database/repositories.js";
import { jobs } from "../src/database/schema.js";
import { parseFileConfig } from "../src/config/load.js";
import {
  backoffMs,
  claimNext,
  completeJob,
  enqueue,
  failJob,
  hasActiveJob,
  recoverStaleJobs,
} from "../src/workers/queue.js";
import { baseFileConfig } from "./helpers.js";

function db(): Db {
  const d = openDatabase({ path: ":memory:" });
  syncRepositories(d, parseFileConfig(baseFileConfig).repositories);
  return d;
}
const later = (ms: number) => new Date(Date.now() + ms);

describe("job queue", () => {
  it("persists jobs and claims them in order of availability", () => {
    const d = db();
    const a = enqueue(d, { type: "t", payload: { n: 1 } }).job;
    enqueue(d, { type: "t", payload: { n: 2 }, availableAt: later(60_000) });
    const claimed = claimNext(d, "w1")!;
    expect(claimed.id).toBe(a.id);
    expect(claimed).toMatchObject({ status: "running", attempts: 1, lockedBy: "w1" });
    expect(claimNext(d, "w1")).toBeUndefined(); // second job not due yet
  });

  it("deduplicates active jobs per key, but not finished ones", () => {
    const d = db();
    const first = enqueue(d, { type: "sync", payload: {}, dedupeKey: "sync:a" });
    const dup = enqueue(d, { type: "sync", payload: {}, dedupeKey: "sync:a" });
    expect(first.created).toBe(true);
    expect(dup).toEqual({ job: first.job, created: false });
    expect(hasActiveJob(d, "sync:a")).toBe(true);
    completeJob(d, claimNext(d, "w")!.id);
    expect(hasActiveJob(d, "sync:a")).toBe(false);
    expect(enqueue(d, { type: "sync", payload: {}, dedupeKey: "sync:a" }).created).toBe(true);
  });

  it("never runs two jobs for the same repository at once", () => {
    const d = db();
    enqueue(d, { type: "t", payload: {}, repositoryId: "songbook" });
    enqueue(d, { type: "t", payload: {}, repositoryId: "songbook" });
    enqueue(d, { type: "t", payload: {}, repositoryId: "home-server" });
    const first = claimNext(d, "w1")!;
    const second = claimNext(d, "w2")!;
    expect(first.repositoryId).toBe("songbook");
    expect(second.repositoryId).toBe("home-server");
    expect(claimNext(d, "w3")).toBeUndefined();
    completeJob(d, first.id);
    expect(claimNext(d, "w3")?.repositoryId).toBe("songbook");
  });

  it("retries with exponential backoff, then marks the job dead", () => {
    const d = db();
    enqueue(d, { type: "t", payload: {}, maxAttempts: 3 });
    const now = new Date("2026-01-01T00:00:00Z");
    let job = claimNext(d, "w", later(0))!;
    expect(failJob(d, job, "boom", { now })).toEqual({
      dead: false,
      retryAt: new Date(now.getTime() + 30_000),
    });
    d.update(jobs)
      .set({ availableAt: new Date(0) })
      .run();
    job = claimNext(d, "w")!;
    expect(failJob(d, job, "boom", { now }).retryAt).toEqual(new Date(now.getTime() + 60_000));
    d.update(jobs)
      .set({ availableAt: new Date(0) })
      .run();
    job = claimNext(d, "w")!;
    expect(failJob(d, job, "final", { now })).toEqual({ dead: true, retryAt: undefined });
    expect(d.select().from(jobs).get()).toMatchObject({
      status: "dead",
      attempts: 3,
      lastError: "final",
    });
    expect(backoffMs(20)).toBe(3_600_000);
  });

  it("permanent failures are not retried", () => {
    const d = db();
    enqueue(d, { type: "t", payload: {} });
    expect(failJob(d, claimNext(d, "w")!, "bad input", { permanent: true }).dead).toBe(true);
  });

  it("returns jobs interrupted by a crash to the queue", () => {
    const d = db();
    enqueue(d, { type: "t", payload: {} });
    const job = claimNext(d, "w")!;
    expect(job.status).toBe("running");
    expect(recoverStaleJobs(d, new Date(Date.now() - 60_000))).toBe(0); // lease still fresh
    expect(recoverStaleJobs(d, later(1_000))).toBe(1);
    expect(d.select().from(jobs).where(eq(jobs.id, job.id)).get()).toMatchObject({
      status: "pending",
      lockedBy: null,
      attempts: 1,
    });
  });
});
