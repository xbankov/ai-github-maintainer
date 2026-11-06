import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1" || v === "yes");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

/** Process environment: paths, network binding and secrets. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  CONFIG_PATH: z.string().min(1).default("config/repositories.yaml"),
  DATABASE_PATH: z.string().min(1).default("data/db/maintainer.sqlite"),
  WORKSPACE_ROOT: z.string().min(1).default("data/workspaces"),
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  GITHUB_APP_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,

  OPENCODE_SERVER_USERNAME: z.string().min(1).default("opencode"),
  OPENCODE_SERVER_PASSWORD: optionalString,

  /** Global kill switch. When true, no background work is started. */
  MAINTAINER_PAUSED: bool,
});

export type Env = z.infer<typeof envSchema>;
