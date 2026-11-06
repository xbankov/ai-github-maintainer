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
import { WorkspaceManager } from "./workspace/manager.js";

export interface Application {
  config: AppConfig;
  db: Db;
  github: GitHubApp | null;
  opencode: OpenCode;
  workspace: WorkspaceManager;
  health: HealthMonitor;
  http: FastifyInstance;
  close(): Promise<void>;
}

export interface CreateAppOverrides {
  /** Injected fetch for GitHub (tests). */
  githubFetch?: typeof globalThis.fetch;
  /** Injected fetch for OpenCode (tests). */
  opencodeFetch?: typeof globalThis.fetch;
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

  const workspace = new WorkspaceManager({ root: config.paths.workspaceRoot, logger });
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

  return {
    config,
    db,
    github,
    opencode,
    workspace,
    health,
    http,
    async close() {
      await http.close();
      closeDatabase(db);
    },
  };
}
