import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config/load.js";
import { closeDatabase, openDatabase, type Db } from "./database/client.js";
import { syncRepositories } from "./database/repositories.js";
import { getKillSwitch } from "./database/settings.js";
import { GitHubApp } from "./github/app.js";
import { HealthMonitor } from "./health.js";
import { buildHttpServer } from "./http/server.js";
import type { Logger } from "./logger.js";
import { OpenCode } from "./opencode/client.js";
import {
  CONVERSATION_JOB,
  conversationStep,
  onConversationDead,
} from "./orchestrator/conversation.js";
import {
  awaitCi,
  CI_JOB,
  IMPLEMENT_JOB,
  implementTask,
  onImplementationDead,
} from "./orchestrator/implementation.js";
import { OrchestratorContext } from "./orchestrator/context.js";
import { SYNC_JOB, syncRepository } from "./orchestrator/discovery.js";
import { Scheduler } from "./orchestrator/scheduler.js";
import { JobProcessor } from "./workers/processor.js";
import { WorkspaceManager, type WorkspaceRepo } from "./workspace/manager.js";

export interface Application {
  config: AppConfig;
  db: Db;
  github: GitHubApp | null;
  opencode: OpenCode;
  workspace: WorkspaceManager;
  health: HealthMonitor;
  http: FastifyInstance;
  /** Null until the GitHub App is configured. */
  orchestrator: OrchestratorContext | null;
  processor: JobProcessor | null;
  scheduler: Scheduler | null;
  /** Starts polling and job processing (no-op without GitHub). */
  startWorkers(): void;
  close(): Promise<void>;
}

export interface CreateAppOverrides {
  /** Injected fetch for GitHub (tests). */
  githubFetch?: typeof globalThis.fetch;
  /** Injected fetch for OpenCode (tests). */
  opencodeFetch?: typeof globalThis.fetch;
  /** Clone URL override (tests use file:// remotes). */
  remoteUrl?: (repo: WorkspaceRepo) => string;
}

/** Builds every component and runs the start-up steps that need no network. */
export async function createApplication(
  config: AppConfig,
  logger: Logger,
  overrides: CreateAppOverrides = {},
): Promise<Application> {
  const db = openDatabase({ path: config.paths.database });
  logger.info({ path: config.paths.database }, "database ready (migrations applied)");

  const synced = syncRepositories(db, config.file.repositories);
  logger.info(synced, "repositories synchronised with configuration");

  const opencodeSettings = config.file.opencode;
  const agents = new Set([opencodeSettings.analysis_agent, opencodeSettings.implementation_agent]);
  for (const r of config.file.repositories) {
    if (r.opencode.analysis_agent) agents.add(r.opencode.analysis_agent);
    if (r.opencode.implementation_agent) agents.add(r.opencode.implementation_agent);
  }
  const opencode = new OpenCode({
    serverUrl: opencodeSettings.server_url,
    username: config.env.OPENCODE_SERVER_USERNAME,
    password: config.env.OPENCODE_SERVER_PASSWORD,
    requiredAgents: [...agents],
    timeoutMs: opencodeSettings.request_timeout_ms,
    logger,
    fetch: overrides.opencodeFetch,
  });

  const github = config.github
    ? new GitHubApp({
        credentials: config.github,
        apiUrl: config.file.github.api_url,
        logger,
        fetch: overrides.githubFetch,
      })
    : null;
  if (!github) logger.warn("GitHub App is not configured; the service will report not ready");

  const workspace = new WorkspaceManager({
    root: config.paths.workspaceRoot,
    logger,
    remoteUrl: overrides.remoteUrl,
  });
  await workspace.init();

  const health = new HealthMonitor({
    db,
    envPaused: config.env.MAINTAINER_PAUSED,
    opencode,
    github,
    repositories: config.file.repositories.map((r) => ({
      owner: r.owner,
      name: r.name,
      defaultBranch: r.default_branch,
      enabled: r.enabled,
    })),
  });

  const killSwitch = getKillSwitch(db, config.env.MAINTAINER_PAUSED);
  if (killSwitch.paused)
    logger.warn(killSwitch, "kill switch is ON: no background work will start");

  const http = buildHttpServer({ logger, health });

  const orchestrator = github
    ? new OrchestratorContext(config, db, github, opencode, workspace, logger)
    : null;
  const limits = config.file.limits;
  const processor = orchestrator
    ? new JobProcessor({
        db,
        logger,
        envPaused: config.env.MAINTAINER_PAUSED,
        jobTimeoutMs: (limits.analysis_timeout_minutes + 10) * 60_000,
        concurrency: limits.max_parallel_jobs,
        jobTimeouts: {
          [IMPLEMENT_JOB]: (limits.task_timeout_minutes + 10) * 60_000,
          [CI_JOB]: 5 * 60_000,
        },
        handlers: {
          [SYNC_JOB]: async (job, signal) => {
            await syncRepository(orchestrator, job, signal);
          },
          [CONVERSATION_JOB]: (job, signal) => conversationStep(orchestrator, job, signal),
          [IMPLEMENT_JOB]: (job, signal) => implementTask(orchestrator, job, signal),
          [CI_JOB]: (job) => awaitCi(orchestrator, job),
        },
        onDead: async (job) => {
          if (job.type === CONVERSATION_JOB) await onConversationDead(orchestrator, job);
          if (job.type === IMPLEMENT_JOB || job.type === CI_JOB) {
            await onImplementationDead(orchestrator, job);
          }
        },
      })
    : null;
  const scheduler = orchestrator
    ? new Scheduler({
        db,
        logger,
        repositories: config.file.repositories,
        pollIntervalSeconds: config.file.discovery.poll_interval_seconds,
        dailySchedule: config.file.discovery.schedule,
        timezone: config.file.discovery.timezone,
        envPaused: config.env.MAINTAINER_PAUSED,
      })
    : null;

  return {
    config,
    db,
    github,
    opencode,
    workspace,
    health,
    http,
    orchestrator,
    processor,
    scheduler,
    startWorkers() {
      if (!processor || !scheduler) {
        logger.warn("workers not started: GitHub App is not configured");
        return;
      }
      processor.start();
      scheduler.start();
    },
    async close() {
      scheduler?.stop();
      await processor?.stop();
      await http.close();
      closeDatabase(db);
    },
  };
}
