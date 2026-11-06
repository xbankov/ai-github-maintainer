import cron, { type ScheduledTask } from "node-cron";
import type { Db } from "../database/client.js";
import { getKillSwitch } from "../database/settings.js";
import type { Logger } from "../logger.js";
import type { RepositoryConfig } from "../config/schema.js";
import { enqueue } from "../workers/queue.js";
import { SYNC_JOB, syncDedupeKey } from "./discovery.js";
import { enqueueFeatureDiscovery } from "./feature-discovery.js";

/**
 * Polling replaces webhooks: every `pollIntervalSeconds` each enabled repository
 * gets a sync job (deduplicated, so a slow sync never piles up). The daily
 * discovery schedule (SPEC §2.1) enqueues the same job.
 */
export class Scheduler {
  private interval: NodeJS.Timeout | undefined;
  private daily: ScheduledTask | undefined;
  private readonly log: Logger;

  constructor(
    private readonly options: {
      db: Db;
      logger: Logger;
      repositories: RepositoryConfig[];
      pollIntervalSeconds: number;
      dailySchedule: string;
      timezone: string;
      envPaused: boolean;
      /** Feature proposals per repository (0 disables feature discovery). */
      featureSuggestions?: number;
    },
  ) {
    this.log = options.logger.child({ component: "scheduler" });
  }

  /** Enqueues a sync for every enabled repository. Returns how many were new. */
  enqueueSyncs(reason: string): number {
    if (getKillSwitch(this.options.db, this.options.envPaused).paused) return 0;
    let created = 0;
    for (const repo of this.options.repositories.filter((r) => r.enabled)) {
      const res = enqueue(this.options.db, {
        type: SYNC_JOB,
        payload: { repositoryId: repo.id, reason },
        repositoryId: repo.id,
        dedupeKey: syncDedupeKey(repo.id),
        maxAttempts: 3,
      });
      if (res.created) created++;
    }
    return created;
  }

  /** Daily feature discovery, a little after the sync (it only runs when a repository is idle). */
  enqueueFeatureDiscovery(): void {
    if (getKillSwitch(this.options.db, this.options.envPaused).paused) return;
    if ((this.options.featureSuggestions ?? 0) <= 0) return;
    for (const repo of this.options.repositories.filter((r) => r.enabled)) {
      enqueueFeatureDiscovery(this.options, repo.id, 2 * 60_000);
    }
  }

  start(): void {
    if (!cron.validate(this.options.dailySchedule)) {
      throw new Error(`Invalid discovery.schedule "${this.options.dailySchedule}"`);
    }
    this.enqueueSyncs("startup");
    this.interval = setInterval(
      () => this.enqueueSyncs("poll"),
      this.options.pollIntervalSeconds * 1000,
    );
    this.daily = cron.schedule(
      this.options.dailySchedule,
      () => {
        const n = this.enqueueSyncs("daily");
        this.enqueueFeatureDiscovery();
        this.log.info({ enqueued: n }, "daily discovery");
      },
      { timezone: this.options.timezone },
    );
    this.log.info(
      { pollIntervalSeconds: this.options.pollIntervalSeconds, daily: this.options.dailySchedule },
      "scheduler started",
    );
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    void this.daily?.stop();
  }
}
