import { OpenCode as OpenCodeClient, type SessionCreateInput } from "@opencode/client";
import type { Logger } from "../logger.js";

/**
 * Integration with the existing OpenCode server through the official
 * `@opencode/client` package (the OpenCode 2.x client). The orchestrator never
 * starts a server; it connects to the long-running one.
 *
 * Keep the package version equal to the server's major.minor version.
 */
export type Client = ReturnType<typeof OpenCodeClient.make>;
export type PermissionRule = NonNullable<SessionCreateInput["permissions"]>[number];

/** Client version this build was written and tested against. */
export const SUPPORTED_SERVER_VERSION = "2.2";

export interface OpenCodeOptions {
  serverUrl: string;
  username: string;
  password: string | undefined;
  /** Agents the maintainer depends on (analysis + implementation). */
  requiredAgents: string[];
  /** Timeout for ordinary requests. Waiting for an agent passes its own. */
  timeoutMs: number;
  logger: Logger;
  /** Injected in tests. */
  fetch?: typeof globalThis.fetch;
}

export interface OpenCodeStatus {
  ok: boolean;
  problems: string[];
  agents: string[];
  serverVersion?: string;
}

export class OpenCodeError extends Error {
  override name = "OpenCodeError";
}

/**
 * Baseline rules for every maintainer session, applied on top of the agent's own
 * config: deny everything (including MCP and web tools), then allow read-only
 * inspection. Later rules win, so callers append task-specific rules.
 */
export const BASE_SESSION_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "todowrite", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

/** Human-readable reason for a client failure. */
export function describeOpenCodeError(err: unknown, serverUrl: string): string {
  const e = err as { name?: string; reason?: string; message?: string };
  if (e?.name === "UnauthorizedError") {
    return "OpenCode rejected the credentials (check OPENCODE_SERVER_PASSWORD)";
  }
  if (e?.name === "ClientError" && e.reason === "Transport") {
    return `OpenCode server unreachable at ${serverUrl}: ${e.message ?? ""}`;
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `OpenCode request to ${serverUrl} timed out`;
  }
  return `OpenCode request failed: ${e?.name ?? "Error"}: ${e?.message ?? String(err)}`;
}

export class OpenCode {
  readonly client: Client;
  private readonly log: Logger;

  constructor(private readonly options: OpenCodeOptions) {
    this.log = options.logger.child({ component: "opencode" });
    const headers: Record<string, string> = {};
    if (options.password) {
      headers.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    }
    this.client = OpenCodeClient.make({
      baseUrl: options.serverUrl.replace(/\/$/, ""),
      headers,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** Request options: a timeout, optionally combined with a caller's abort signal. */
  private timeout(ms = this.options.timeoutMs, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(ms);
    return { signal: signal ? AbortSignal.any([timeout, signal]) : timeout };
  }

  /** Reachability, credentials, server version and agent availability. */
  async check(): Promise<OpenCodeStatus> {
    const problems: string[] = [];
    let agents: string[] = [];
    let serverVersion: string | undefined;
    try {
      serverVersion = (await this.client.server.info(this.timeout())).version;
      if (!serverVersion.startsWith(`${SUPPORTED_SERVER_VERSION}.`)) {
        problems.push(
          `OpenCode server version ${serverVersion} differs from the supported ${SUPPORTED_SERVER_VERSION}.x (update @opencode/client to match)`,
        );
      }
      agents = (await this.client.agent.list(undefined, this.timeout())).data.map((a) => a.id);
      for (const required of this.options.requiredAgents) {
        if (!agents.includes(required)) {
          problems.push(`OpenCode agent "${required}" is not configured on the server`);
        }
      }
    } catch (err) {
      problems.push(describeOpenCodeError(err, this.options.serverUrl));
    }
    for (const p of problems) this.log.error(p);
    return { ok: problems.length === 0, problems, agents, serverVersion };
  }

  /** Creates a session working in `directory` (a task worktree) with deny-by-default permissions. */
  async createSession(input: {
    directory: string;
    title: string;
    agent: string;
    model?: string;
    permissions?: PermissionRule[];
  }): Promise<string> {
    const session = await this.client.session.create(
      {
        title: input.title,
        agent: input.agent,
        location: { directory: input.directory },
        ...(input.model ? { model: parseModel(input.model) } : {}),
        permissions: [...BASE_SESSION_PERMISSIONS, ...(input.permissions ?? [])],
      },
      this.timeout(),
    );
    this.log.info(
      { sessionId: session.id, directory: input.directory, agent: input.agent },
      "session created",
    );
    return session.id;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.session.remove({ sessionID: sessionId }, this.timeout());
  }

  /**
   * Sends a prompt and waits until the agent loop is idle.
   * Returns the text of the latest assistant message.
   */
  async run(
    sessionId: string,
    text: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    await this.client.session.prompt(
      { sessionID: sessionId, text },
      this.timeout(undefined, signal),
    );
    try {
      await this.client.session.wait({ sessionID: sessionId }, this.timeout(timeoutMs, signal));
    } catch (err) {
      // Stop the agent: on timeout or when the caller cancels.
      await this.client.session
        .interrupt({ sessionID: sessionId }, this.timeout())
        .catch(() => undefined);
      throw new OpenCodeError(
        signal?.aborted
          ? "Agent run cancelled"
          : `Agent did not finish within ${timeoutMs} ms: ${describeOpenCodeError(err, this.options.serverUrl)}`,
      );
    }
    const messages = await this.client.session.context({ sessionID: sessionId }, this.timeout());
    const last = [...messages].reverse().find((m) => m.type === "assistant");
    if (!last || last.type !== "assistant") throw new OpenCodeError("Agent produced no reply");
    return last.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
  }

  /** Transient completion from the session context; does not change the session history. */
  async generate(
    sessionId: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    return (
      await this.client.session.generate(
        { sessionID: sessionId, prompt },
        this.timeout(timeoutMs, signal),
      )
    ).text;
  }
}

/** "provider/model" → OpenCode model reference. */
export function parseModel(model: string): { providerID: string; id: string } {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) throw new OpenCodeError(`Invalid model "${model}"`);
  return { providerID: model.slice(0, idx), id: model.slice(idx + 1) };
}
