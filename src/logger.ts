import { pino, type Logger, type DestinationStream } from "pino";

export type { Logger };

/**
 * Paths whose values must never reach the logs. pino redaction is path based,
 * so secrets must be logged under one of these keys (or not at all).
 */
export const REDACT_PATHS = [
  "token",
  "*.token",
  "password",
  "*.password",
  "privateKey",
  "*.privateKey",
  "webhookSecret",
  "*.webhookSecret",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  "env.GITHUB_APP_PRIVATE_KEY",
  "env.GITHUB_WEBHOOK_SECRET",
  "env.OPENCODE_SERVER_PASSWORD",
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "ai-github-maintainer" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
