import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configSchema, type FileConfig, type RepositoryConfig } from "./schema.js";
import { envSchema, type Env } from "./env.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string | undefined;
}

export interface AppConfig {
  env: Env;
  file: FileConfig;
  /** null when the GitHub App is not configured yet (the service still starts, but is not ready). */
  github: GitHubAppCredentials | null;
  paths: { config: string; database: string; workspaceRoot: string };
  /** Non-fatal configuration problems (e.g. deprecated keys), logged at start-up. */
  warnings: string[];
}

function formatZodError(prefix: string, error: z.ZodError): ConfigError {
  return new ConfigError(`${prefix}\n${z.prettifyError(error)}`);
}

export function parseFileConfig(raw: unknown): FileConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) throw formatZodError("Invalid repository configuration:", result.error);
  return result.data;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw formatZodError("Invalid environment:", result.error);
  return result.data;
}

function loadGitHubCredentials(env: Env): GitHubAppCredentials | null {
  const hasKey = Boolean(env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH);
  if (!env.GITHUB_APP_ID && !hasKey) return null;
  if (!env.GITHUB_APP_ID)
    throw new ConfigError("GITHUB_APP_ID is required when a private key is set");
  if (!hasKey) {
    throw new ConfigError(
      "GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_APP_PRIVATE_KEY) is required when GITHUB_APP_ID is set",
    );
  }
  if (env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new ConfigError("Set only one of GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH");
  }
  let privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
    } catch (err) {
      throw new ConfigError(
        `Cannot read GITHUB_APP_PRIVATE_KEY_PATH (${env.GITHUB_APP_PRIVATE_KEY_PATH}): ${(err as Error).message}`,
      );
    }
  }
  if (!privateKey || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new ConfigError("GitHub App private key is not a PEM private key");
  }
  return { appId: env.GITHUB_APP_ID, privateKey, webhookSecret: env.GITHUB_WEBHOOK_SECRET };
}

export function buildAppConfig(env: Env, file: FileConfig, cwd = process.cwd()): AppConfig {
  const warnings: string[] = [];
  if (file.github.trusted_issue_authors) {
    warnings.push(
      "github.trusted_issue_authors is deprecated and ignored: issues are enabled by a maintainer adding github.allowed_label. Remove the key.",
    );
  }
  return {
    warnings,
    env,
    file,
    github: loadGitHubCredentials(env),
    paths: {
      config: resolve(cwd, env.CONFIG_PATH),
      database: resolve(cwd, env.DATABASE_PATH),
      workspaceRoot: resolve(cwd, env.WORKSPACE_ROOT),
    },
  };
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AppConfig {
  const env = parseEnv(source);
  const configPath = resolve(cwd, env.CONFIG_PATH);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read CONFIG_PATH (${configPath}): ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${configPath}: ${(err as Error).message}`);
  }
  return buildAppConfig(env, parseFileConfig(raw), cwd);
}

/** Effective per-repository OpenCode settings (repository override → global default). */
export function opencodeSettingsFor(config: AppConfig, repo: RepositoryConfig) {
  return {
    analysisAgent: repo.opencode.analysis_agent ?? config.file.opencode.analysis_agent,
    implementationAgent:
      repo.opencode.implementation_agent ?? config.file.opencode.implementation_agent,
    model: repo.opencode.model ?? config.file.opencode.model,
  };
}
