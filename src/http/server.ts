import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { HealthMonitor } from "../health.js";
import type { Logger } from "../logger.js";

export interface HttpServerOptions {
  logger: Logger;
  health: HealthMonitor;
}

export function buildHttpServer({ logger, health }: HttpServerOptions): FastifyInstance {
  const loggerInstance: FastifyBaseLogger = logger.child({ component: "http" });
  const app = Fastify({
    loggerInstance,
    bodyLimit: 25 * 1024 * 1024, // GitHub webhook payloads can be large
    trustProxy: true, // runs behind a reverse proxy / tunnel
  });

  // Liveness: the process is up and serving requests. No dependency checks.
  app.get("/healthz", { logLevel: "warn" }, () => ({ status: "ok" }));

  // Readiness: dependencies usable. 503 when not ready so orchestration/monitoring notices.
  app.get("/readyz", { logLevel: "warn" }, async (_req, reply) => {
    const report = await health.report();
    return reply.code(report.ready ? 200 : 503).send(report);
  });

  return app;
}
