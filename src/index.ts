import { createApplication } from "./app.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger level is unknown before the config loads; fail loudly and plainly.
    createLogger("info").fatal(
      { err: err instanceof ConfigError ? err.message : err },
      "configuration error",
    );
    process.exit(78); // EX_CONFIG
  }

  const logger = createLogger(config.env.LOG_LEVEL);
  for (const warning of config.warnings) logger.warn(warning);
  logger.info(
    {
      repositories: config.file.repositories.map(
        (r) => `${r.owner}/${r.name}${r.enabled ? "" : " (disabled)"}`,
      ),
      opencode: config.file.opencode.server_url,
      workspaceRoot: config.paths.workspaceRoot,
    },
    "starting ai-github-maintainer",
  );

  const app = await createApplication(config, logger);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled promise rejection"));

  await app.http.listen({ host: config.env.HTTP_HOST, port: config.env.HTTP_PORT });
  app.startWorkers();

  // Report dependency status once at start-up (does not block serving /healthz).
  const report = await app.health.report(true);
  const summary = Object.fromEntries(
    Object.entries(report.components).map(([k, v]) => [k, v.ok ? "ok" : v.problems]),
  );
  if (report.ready)
    logger.info({ components: summary, killSwitch: report.killSwitch }, "service ready");
  else
    logger.warn(
      { components: summary, killSwitch: report.killSwitch },
      "service started but NOT ready",
    );
}

main().catch((err: unknown) => {
  createLogger("info").fatal({ err }, "fatal start-up error");
  process.exit(1);
});
