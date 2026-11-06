import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { buildAppConfig, parseEnv, parseFileConfig, type AppConfig } from "../src/config/load.js";
import { createLogger } from "../src/logger.js";

export const silentLogger = createLogger("silent");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

export function tempDir(prefix = "maintainer-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const baseFileConfig = {
  repositories: [
    { id: "songbook", owner: "xbankov", name: "songbook" },
    { id: "home-server", owner: "xbankov", name: "home-server" },
  ],
  github: { authorized_users: ["xbankov"] },
  opencode: { server_url: "http://opencode.test:4096" },
};

export function testConfig(
  overrides: { env?: Record<string, string>; file?: Record<string, unknown> } = {},
): AppConfig {
  const dir = tempDir();
  const env = parseEnv({
    DATABASE_PATH: join(dir, "db.sqlite"),
    WORKSPACE_ROOT: join(dir, "workspaces"),
    OPENCODE_SERVER_PASSWORD: "test-password",
    ...overrides.env,
  });
  return buildAppConfig(env, parseFileConfig({ ...baseFileConfig, ...overrides.file }), dir);
}

/** Runs git in a test fixture with a fixed identity and no user config. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

export type FetchHandler = (req: {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** Minimal fetch mock: routes by handler, records requests, 404 for unhandled. */
export function mockFetch(handler: FetchHandler) {
  const calls: Array<{ method: string; url: URL; headers: Headers; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body,
    };
    calls.push(call);
    const res = handler(call) ?? { status: 404, body: { message: "Not Found" } };
    const response = new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...res.headers },
    });
    // Real fetch responses carry their URL; some clients (Octokit pagination) rely on it.
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };
  return { fetch, calls };
}
