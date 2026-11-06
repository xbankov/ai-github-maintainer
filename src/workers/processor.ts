import { randomUUID } from "node:crypto";
import type { Db } from "../database/client.js";
import { auditLog } from "../database/schema.js";
import { getKillSwitch } from "../database/settings.js";
import type { Logger } from "../logger.js";
import { claimNext, completeJob, failJob, recoverStaleJobs, type Job } from "./queue.js";

/** Thrown by a handler for failures that retrying cannot fix. */
export class PermanentJobError extends Error {
  override name = "PermanentJobError";
}

export type JobHandler = (job: Job) => Promise<void>;

export interface ProcessorOptions {
  db: Db;
  logger: Logger;
  handlers: Record<string, JobHandler>;
  envPaused: boolean;
  /** Called when a job fails for the last time. */
  onDead?: (job: Job, error: string) => Promise<void>;
  /** Hard limit for one job. */
  jobTimeoutMs: number;
  pollIntervalMs?: number;
  /** Parallel workers (each runs one job at a time). Default 1. */
  concurrency?: number;
}

/**
 * Runs queued jobs with a small, fixed number of workers (memory is tight on the
 * home server). Per-repository exclusivity is enforced by the queue itself, so
 * different repositories progress in parallel.
 */
export class JobProcessor {
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private stopped = true;
  private readonly log: Logger;

  constructor(private readonly options: ProcessorOptions) {
    this.log = options.logger.child({ component: "processor", worker: this.workerId });
  }

  start(): void {
    const recovered = recoverStaleJobs(this.options.db, new Date());
    if (recovered) this.log.warn({ recovered }, "returned interrupted jobs to the queue");
    this.stopped = false;
    for (let i = 0; i < (this.options.concurrency ?? 1); i++) this.schedule(i * 250);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.all([...this.running]);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const run = this.tick().finally(() => this.running.delete(run));
      this.running.add(run);
    }, delayMs);
    this.timers.add(timer);
  }

  /** Runs at most one job. Returns true if a job was processed. */
  async runOnce(): Promise<boolean> {
    if (getKillSwitch(this.options.db, this.options.envPaused).paused) return false;
    const job = claimNext(this.options.db, this.workerId);
    if (!job) return false;
    const handler = this.options.handlers[job.type];
    const log = this.log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    if (!handler) {
      failJob(this.options.db, job, `no handler for job type "${job.type}"`, { permanent: true });
      log.error("no handler for job type");
      return true;
    }
    log.info("job started");
    const started = Date.now();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handler(job),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`job timed out after ${this.options.jobTimeoutMs} ms`)),
            this.options.jobTimeoutMs,
          );
        }),
      ]);
      completeJob(this.options.db, job.id);
      log.info({ ms: Date.now() - started }, "job succeeded");
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const result = failJob(this.options.db, job, message, {
        permanent: err instanceof PermanentJobError,
      });
      if (result.dead) {
        log.error({ err: message }, "job failed permanently");
        this.options.db
          .insert(auditLog)
          .values({
            repositoryId: job.repositoryId,
            action: "job.dead",
            details: { jobId: job.id, type: job.type, error: message },
          })
          .run();
        await this.options
          .onDead?.(job, message)
          .catch((e: unknown) => log.error({ err: e }, "onDead handler failed"));
      } else {
        log.warn({ err: message, retryAt: result.retryAt }, "job failed, will retry");
      }
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }

  private async tick(): Promise<void> {
    let didWork = false;
    try {
      didWork = await this.runOnce();
    } catch (err) {
      this.log.error({ err }, "processor error");
    }
    this.schedule(didWork ? 0 : (this.options.pollIntervalMs ?? 2_000));
  }
}
