import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkAppPermissions, GitHubApp } from "../src/github/app.js";
import { mockFetch, silentLogger } from "./helpers.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const goodPermissions = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
};

function fakeGitHub(
  opts: {
    permissions?: Record<string, string>;
    repos?: Record<string, { default_branch: string; private: boolean; archived?: boolean }>;
    visible?: string[];
  } = {},
) {
  const repos = opts.repos ?? {
    "xbankov/songbook": { default_branch: "main", private: false },
    "xbankov/home-server": { default_branch: "main", private: true },
  };
  return mockFetch(({ method, url, headers, body }) => {
    const auth = headers.get("authorization") ?? "";
    const path = decodeURIComponent(url.pathname).replace(/^\/users\/xbankov$/i, "/users/xbankov");
    const isJwt = auth.startsWith("bearer ey");
    const isInstallation = auth === "token ghs_installation";
    if (method === "GET" && path === "/app" && isJwt)
      return { body: { id: 123, slug: "maint", permissions: opts.permissions ?? goodPermissions } };
    if (method === "GET" && path === "/users/maint[bot]")
      return { body: { id: 999, login: "maint[bot]" } };
    const inst = path.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
    if (method === "GET" && inst && isJwt)
      return repos[inst[1]!]
        ? { body: { id: 55 } }
        : { status: 404, body: { message: "Not Found" } };
    if (method === "POST" && path === "/app/installations/55/access_tokens" && isJwt) {
      const req = (body ?? {}) as { repositories?: string[]; permissions?: unknown };
      const token = req.repositories
        ? `ghs_scoped_${req.repositories.join("_")}`
        : "ghs_installation";
      return {
        status: 201,
        body: {
          token,
          expires_at: "2099-01-01T00:00:00Z",
          permissions: req.permissions ?? goodPermissions,
          repository_selection: "selected",
        },
      };
    }
    const repo = path.match(/^\/repos\/([^/]+\/[^/]+)$/);
    if (method === "GET" && repo && isInstallation && repos[repo[1]!])
      return { body: { full_name: repo[1], ...repos[repo[1]!] } };
    if (method === "GET" && path === "/installation/repositories" && isInstallation) {
      const visible = opts.visible ?? Object.keys(repos);
      return {
        body: {
          total_count: visible.length,
          repositories: visible.map((full_name) => ({ full_name })),
        },
      };
    }
    if (method === "GET" && path === "/users/xbankov" && isInstallation)
      return { body: { id: 4242, login: "xbankov" } };
    return undefined;
  });
}

function makeApp(mock: ReturnType<typeof fakeGitHub>) {
  return new GitHubApp({
    credentials: { appId: "123", privateKey, webhookSecret: undefined },
    apiUrl: "https://api.github.test",
    logger: silentLogger,
    fetch: mock.fetch,
  });
}

const configured = [
  { owner: "xbankov", name: "songbook", defaultBranch: "main" },
  { owner: "xbankov", name: "home-server", defaultBranch: "main" },
];

describe("GitHub App", () => {
  it("authenticates as the app and derives the bot identity", async () => {
    const mock = fakeGitHub();
    const identity = await makeApp(mock).getIdentity();
    expect(identity).toMatchObject({
      appId: 123,
      slug: "maint",
      botLogin: "maint[bot]",
      botUserId: 999,
    });
    expect(identity.botEmail).toBe("999+maint[bot]@users.noreply.github.com");
  });

  it("mints repository-scoped tokens with explicit permissions", async () => {
    const mock = fakeGitHub();
    const token = await makeApp(mock).createRepositoryToken(
      { owner: "xbankov", name: "songbook" },
      { contents: "write" },
    );
    expect(token.token).toBe("ghs_scoped_songbook");
    const req = mock.calls.find((c) => c.url.pathname === "/app/installations/55/access_tokens");
    expect(req?.body).toEqual({ repositories: ["songbook"], permissions: { contents: "write" } });
  });

  it("caches installation ids", async () => {
    const mock = fakeGitHub();
    const app = makeApp(mock);
    await app.getInstallationId({ owner: "xbankov", name: "songbook" });
    await app.getInstallationId({ owner: "XBANKOV", name: "SONGBOOK" });
    expect(mock.calls.filter((c) => c.url.pathname.endsWith("/installation"))).toHaveLength(1);
  });

  it("checks configured repositories and warns about public ones", async () => {
    const results = await makeApp(fakeGitHub()).checkRepositories(configured);
    expect(results.map((r) => [r.repo, r.ok, r.private])).toEqual([
      ["xbankov/songbook", true, false],
      ["xbankov/home-server", true, true],
    ]);
    expect(results[0]!.warnings.join()).toMatch(/public/);
    expect(results[1]!.warnings).toEqual([]);
  });

  it("reports a missing installation, a wrong default branch and archived repos", async () => {
    const mock = fakeGitHub({
      repos: { "xbankov/songbook": { default_branch: "master", private: true, archived: true } },
    });
    const [songbook, homeServer] = await makeApp(mock).checkRepositories(configured);
    expect(songbook!.ok).toBe(false);
    expect(songbook!.problems.join("\n")).toMatch(/default branch is "master"/);
    expect(songbook!.problems.join("\n")).toMatch(/archived/);
    expect(homeServer!.ok).toBe(false);
    expect(homeServer!.problems).toEqual([
      "GitHub App is not installed on this repository (or it does not exist)",
    ]);
  });

  it("warns when the installation can see unconfigured repositories", async () => {
    const mock = fakeGitHub({
      visible: ["xbankov/songbook", "xbankov/home-server", "xbankov/private-diary"],
    });
    const results = await makeApp(mock).checkRepositories(configured);
    expect(results.flatMap((r) => r.warnings).join()).toMatch(/xbankov\/private-diary/);
  });

  it("resolves logins to numeric ids", async () => {
    const ids = await makeApp(fakeGitHub()).resolveUserIds(["XBankov"], {
      owner: "xbankov",
      name: "songbook",
    });
    expect(ids.get("xbankov")).toBe(4242);
  });
});

describe("App permission policy", () => {
  it("accepts exactly the minimum permissions", () => {
    expect(checkAppPermissions(goodPermissions)).toEqual([]);
  });

  it("flags missing and insufficient permissions", () => {
    expect(checkAppPermissions({ ...goodPermissions, issues: "read" })).toEqual([
      "missing permission issues:write (has read)",
    ]);
    expect(checkAppPermissions({ metadata: "read" })).toHaveLength(3);
  });

  it("flags forbidden permissions such as administration and workflows", () => {
    const problems = checkAppPermissions({
      ...goodPermissions,
      administration: "read",
      workflows: "write",
    });
    expect(problems).toEqual([
      "forbidden permission granted: administration:read",
      "forbidden permission granted: workflows:write",
    ]);
  });
});
