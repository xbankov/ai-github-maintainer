import { describe, expect, it } from "vitest";
import { BASE_SESSION_PERMISSIONS, OpenCode, parseModel } from "../src/opencode/client.js";
import { mockFetch, silentLogger } from "./helpers.js";

const auth = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;

/** Fake OpenCode 2.2 server with the response shapes of the real one. */
function fakeServer(opts: { agents?: string[]; version?: string; replies?: string[] } = {}) {
  return mockFetch(({ method, url, headers }) => {
    if (headers.get("authorization") !== auth) {
      return {
        status: 401,
        body: { _tag: "UnauthorizedError", message: "Authentication required" },
      };
    }
    const p = url.pathname;
    if (method === "GET" && p === "/api/info")
      return { body: { version: opts.version ?? "2.2.5" } };
    if (method === "GET" && p === "/api/agent") {
      const ids = opts.agents ?? ["build", "plan", "maintainer-plan", "maintainer-build"];
      return { body: { location: { directory: "/" }, data: ids.map((id) => ({ id, name: id })) } };
    }
    if (method === "POST" && p === "/api/session")
      return { body: { data: { id: "ses_1", agent: "maintainer-plan" } } };
    if (method === "DELETE" && p === "/api/session/ses_1") return { status: 204 };
    if (method === "POST" && p === "/api/session/ses_1/prompt") {
      return {
        body: {
          data: {
            id: "msg_1",
            sessionID: "ses_1",
            type: "user",
            time: { created: 1 },
            payload: { text: "x" },
          },
        },
      };
    }
    if (method === "POST" && p === "/api/experimental/session/ses_1/wait") return { status: 204 };
    if (method === "GET" && p === "/api/session/ses_1/context") {
      return {
        body: {
          data: [
            { id: "m1", type: "user", time: { created: 1 } },
            ...(opts.replies ?? ["first", "final answer"]).map((text, i) => ({
              id: `a${i}`,
              type: "assistant",
              time: { created: 2 + i },
              agent: "maintainer-plan",
              model: { id: "m", providerID: "p" },
              content: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text },
              ],
            })),
          ],
        },
      };
    }
    if (method === "POST" && p === "/api/session/ses_1/generate")
      return { body: { data: { text: '{"ok":true}' } } };
    return undefined;
  });
}

function client(mock: ReturnType<typeof fakeServer>, password = "pw") {
  return new OpenCode({
    serverUrl: "http://opencode.test:4096/",
    username: "opencode",
    password,
    requiredAgents: ["maintainer-plan", "maintainer-build"],
    timeoutMs: 5_000,
    logger: silentLogger,
    fetch: mock.fetch,
  });
}

describe("OpenCode integration (@opencode/client)", () => {
  it("authenticates, checks the server version and the required agents", async () => {
    const mock = fakeServer();
    const status = await client(mock).check();
    expect(status).toEqual({
      ok: true,
      problems: [],
      serverVersion: "2.2.5",
      agents: ["build", "plan", "maintainer-plan", "maintainer-build"],
    });
    expect(mock.calls.every((c) => c.headers.get("authorization") === auth)).toBe(true);
  });

  it("reports wrong credentials clearly", async () => {
    const status = await client(fakeServer(), "wrong").check();
    expect(status.ok).toBe(false);
    expect(status.problems).toEqual([
      "OpenCode rejected the credentials (check OPENCODE_SERVER_PASSWORD)",
    ]);
  });

  it("reports an unsupported server version", async () => {
    const status = await client(fakeServer({ version: "2.3.0" })).check();
    expect(status.problems[0]).toMatch(/2\.3\.0 differs from the supported 2\.2\.x/);
  });

  it("reports missing maintainer agents", async () => {
    const status = await client(fakeServer({ agents: ["build", "plan"] })).check();
    expect(status.problems).toEqual([
      'OpenCode agent "maintainer-plan" is not configured on the server',
      'OpenCode agent "maintainer-build" is not configured on the server',
    ]);
  });

  it("reports an unreachable server", async () => {
    const oc = new OpenCode({
      serverUrl: "http://127.0.0.1:1",
      username: "opencode",
      password: "pw",
      requiredAgents: [],
      timeoutMs: 2_000,
      logger: silentLogger,
    });
    const status = await oc.check();
    expect(status.ok).toBe(false);
    expect(status.problems[0]).toMatch(/unreachable/);
  });

  it("creates sessions in a directory with deny-by-default permissions and the model", async () => {
    const mock = fakeServer();
    const id = await client(mock).createSession({
      directory: "/data/workspaces/worktrees/songbook/issue-1",
      title: "issue #1",
      agent: "maintainer-plan",
      model: "opencode-go/deepseek-v4.1-flash",
      permissions: [{ action: "bash", resource: "pytest*", effect: "allow" }],
    });
    expect(id).toBe("ses_1");
    const body = mock.calls.find((c) => c.method === "POST")!.body as Record<string, unknown> & {
      permissions: unknown[];
    };
    expect(body.agent).toBe("maintainer-plan");
    expect(body.location).toEqual({ directory: "/data/workspaces/worktrees/songbook/issue-1" });
    expect(body.model).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash" });
    expect(body.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(body.permissions).toContainEqual({
      action: "external_directory",
      resource: "*",
      effect: "deny",
    });
    expect(body.permissions.at(-1)).toEqual({
      action: "bash",
      resource: "pytest*",
      effect: "allow",
    });
  });

  it("runs a prompt to completion and returns the latest assistant text", async () => {
    const mock = fakeServer();
    const text = await client(mock).run("ses_1", "do it", 10_000);
    expect(text).toBe("final answer");
    expect(mock.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/session/ses_1/prompt",
      "POST /api/experimental/session/ses_1/wait",
      "GET /api/session/ses_1/context",
    ]);
    expect(mock.calls[0]!.body).toEqual({ text: "do it" });
  });

  it("generates and deletes", async () => {
    const mock = fakeServer();
    const oc = client(mock);
    expect(await oc.generate("ses_1", "json please", 5_000)).toBe('{"ok":true}');
    await oc.deleteSession("ses_1");
    expect(mock.calls.at(-1)?.method).toBe("DELETE");
  });

  it("base permissions never allow edits, shell, web or MCP tools", () => {
    const allowed = BASE_SESSION_PERMISSIONS.filter((r) => r.effect === "allow").map(
      (r) => r.action,
    );
    expect(new Set(allowed)).toEqual(new Set(["read", "glob", "grep", "list", "todowrite"]));
  });

  it("parses provider/model references", () => {
    expect(parseModel("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    expect(parseModel("p/a/b")).toEqual({ providerID: "p", id: "a/b" });
    expect(() => parseModel("nomodel")).toThrow();
  });
});
