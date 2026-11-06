import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitEnv, runGit } from "../src/workspace/git.js";
import {
  validateBranchName,
  WorkspaceError,
  WorkspaceManager,
  type WorkspaceRepo,
} from "../src/workspace/manager.js";
import { git, silentLogger, tempDir } from "./helpers.js";

const repo: WorkspaceRepo = {
  id: "songbook",
  owner: "xbankov",
  name: "songbook",
  defaultBranch: "main",
};

/** A local "GitHub": a bare origin seeded with one commit on main. */
function setupOrigin() {
  const base = tempDir();
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  git(base, "init", "--bare", "--initial-branch=main", origin);
  git(base, "init", "--initial-branch=main", seed);
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const manager = new WorkspaceManager({
    root: join(base, "workspaces"),
    logger: silentLogger,
    remoteUrl: () => `file://${origin}`,
  });
  return { base, origin, seed, manager };
}

describe("workspace manager", () => {
  it("clones once, then fetches new commits", async () => {
    const { seed, manager } = setupOrigin();
    await manager.init();
    const first = await manager.syncRepository(repo);
    expect(first).toBe(git(seed, "rev-parse", "HEAD"));

    writeFileSync(join(seed, "CHANGELOG.md"), "v2\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "second");
    git(seed, "push", "-q", "origin", "main");
    const second = await manager.syncRepository(repo);
    expect(second).toBe(git(seed, "rev-parse", "HEAD"));
    expect(second).not.toBe(first);
  });

  it("creates an isolated worktree on a new ai/ branch from the default branch", async () => {
    const { seed, manager } = setupOrigin();
    await manager.syncRepository(repo);
    const wt = await manager.createWorktree(repo, { taskKey: "issue-42", branch: "ai/issue-42" });
    expect(wt.path).toBe(manager.worktreeDir(repo, "issue-42"));
    expect(wt.branch).toBe("ai/issue-42");
    expect(wt.head).toBe(git(seed, "rev-parse", "HEAD"));
    expect(readFileSync(join(wt.path, "README.md"), "utf8")).toBe("hello\n");
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("ai/issue-42");
  });

  it("is idempotent: re-attaching to an existing worktree returns it", async () => {
    const { manager } = setupOrigin();
    await manager.syncRepository(repo);
    const a = await manager.createWorktree(repo, { taskKey: "issue-1", branch: "ai/issue-1" });
    const b = await manager.createWorktree(repo, { taskKey: "issue-1", branch: "ai/issue-1" });
    expect(b).toEqual(a);
    await expect(
      manager.createWorktree(repo, { taskKey: "issue-1", branch: "ai/other" }),
    ).rejects.toThrow(/expected ai\/other/);
  });

  it("reuses an existing local branch after its worktree was removed (restart recovery)", async () => {
    const { manager } = setupOrigin();
    await manager.syncRepository(repo);
    const wt = await manager.createWorktree(repo, { taskKey: "issue-5", branch: "ai/issue-5" });
    writeFileSync(join(wt.path, "fix.txt"), "work\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-m", "wip");
    const commit = git(wt.path, "rev-parse", "HEAD");
    await manager.removeWorktree(repo, {
      taskKey: "issue-5",
      branch: "ai/issue-5",
      deleteBranch: false,
    });
    const again = await manager.createWorktree(repo, { taskKey: "issue-5", branch: "ai/issue-5" });
    expect(again.head).toBe(commit);
  });

  it("fetching never moves a task branch", async () => {
    const { seed, manager } = setupOrigin();
    await manager.syncRepository(repo);
    const wt = await manager.createWorktree(repo, { taskKey: "issue-9", branch: "ai/issue-9" });
    writeFileSync(join(seed, "other.txt"), "x\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "upstream change");
    git(seed, "push", "-q", "origin", "main");
    await manager.syncRepository(repo);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(wt.head);
  });

  it("removes worktrees and branches, and tolerates repeated removal", async () => {
    const { manager } = setupOrigin();
    await manager.syncRepository(repo);
    const wt = await manager.createWorktree(repo, { taskKey: "issue-3", branch: "ai/issue-3" });
    await manager.removeWorktree(repo, { taskKey: "issue-3", branch: "ai/issue-3" });
    expect(existsSync(wt.path)).toBe(false);
    expect(await manager.listWorktrees(repo)).toEqual([]);
    expect(git(manager.repoDir(repo), "branch", "--list", "ai/issue-3")).toBe("");
    await expect(
      manager.removeWorktree(repo, { taskKey: "issue-3", branch: "ai/issue-3" }),
    ).resolves.toBeUndefined();
  });

  it("refuses the default branch, non-ai branches and path escapes", async () => {
    const { manager } = setupOrigin();
    await manager.syncRepository(repo);
    expect(() => validateBranchName("main", "main")).toThrow(WorkspaceError);
    expect(() => validateBranchName("feature/x", "main")).toThrow(/ai\/<name>/);
    expect(() => validateBranchName("ai/../main", "main")).toThrow(WorkspaceError);
    expect(() => validateBranchName("ai/x.lock", "main")).toThrow(WorkspaceError);
    expect(() => validateBranchName("ai/issue-42", "ai/issue-42")).toThrow(/default branch/);
    expect(() => manager.worktreeDir(repo, "../escape")).toThrow(/Invalid task key/);
    expect(() => manager.repoDir({ ...repo, id: "../x" })).toThrow(/Invalid repository id/);
    await expect(manager.createWorktree(repo, { taskKey: "t", branch: "main" })).rejects.toThrow(
      WorkspaceError,
    );
  });

  it("requires an absolute root and a cloned repository", async () => {
    expect(() => new WorkspaceManager({ root: "relative", logger: silentLogger })).toThrow(
      /absolute/,
    );
    const { manager } = setupOrigin();
    await expect(manager.createWorktree(repo, { taskKey: "t", branch: "ai/t" })).rejects.toThrow(
      /not cloned/,
    );
  });

  it("never persists credentials in the repository config", async () => {
    const { manager } = setupOrigin();
    await manager.syncRepository(repo, "ghs_supersecrettoken123");
    const wt = await manager.createWorktree(repo, { taskKey: "issue-1", branch: "ai/issue-1" });
    const config = readFileSync(join(manager.repoDir(repo), "config"), "utf8");
    expect(config).not.toContain("ghs_supersecrettoken123");
    expect(config.toLowerCase()).not.toContain("extraheader");
    expect(config).toContain("hooksPath = /dev/null");
    expect(existsSync(join(wt.path, ".git"))).toBe(true);
  });
});

describe("git runner", () => {
  it("passes the token only via per-process config env", () => {
    const env = gitEnv({ token: "ghs_abc" });
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_abc").toString("base64")}`,
    );
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv().GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("redacts the token from error messages", async () => {
    const err = await runGit(["ls-remote", "https://x-access-token:ghs_leak@127.0.0.1:1/r.git"], {
      token: "ghs_leak",
      timeoutMs: 10_000,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("ghs_leak");
  });

  it("enforces timeouts", async () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    // `hash-object --stdin` blocks on the (never closed) stdin pipe until the timeout kills it.
    await expect(runGit(["hash-object", "--stdin"], { cwd: dir, timeoutMs: 300 })).rejects.toThrow(
      /timed out/,
    );
  });
});
