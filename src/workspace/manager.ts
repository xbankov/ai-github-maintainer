import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../logger.js";
import { GitError, runGit } from "./git.js";

export interface WorkspaceRepo {
  /** Config id, used for directory names. */
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface WorkspaceOptions {
  root: string;
  logger: Logger;
  /** Override the clone URL (tests use file:// remotes). */
  remoteUrl?: (repo: WorkspaceRepo) => string;
  gitTimeoutMs?: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const TASK_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Branches the maintainer may create: always under ai/. */
const BRANCH_RE = /^ai\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function validateBranchName(branch: string, defaultBranch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith(".lock")) {
    throw new WorkspaceError(`Invalid branch name "${branch}" (must match ai/<name>)`);
  }
  if (branch === defaultBranch) {
    throw new WorkspaceError(`Refusing to use the default branch "${defaultBranch}"`);
  }
}

/**
 * Manages one bare clone per repository and one git worktree per task:
 *
 *   <root>/repos/<repo-id>.git          bare clone, remote branches in refs/remotes/origin/*
 *   <root>/worktrees/<repo-id>/<task>   isolated working copy for one task
 *
 * Credentials are never stored: every network operation receives a fresh token.
 */
export class WorkspaceManager {
  readonly root: string;
  private readonly log: Logger;

  constructor(private readonly options: WorkspaceOptions) {
    if (!isAbsolute(options.root))
      throw new WorkspaceError("Workspace root must be an absolute path");
    this.root = resolve(options.root);
    this.log = options.logger.child({ component: "workspace" });
  }

  /** Resolves a path under the workspace root, refusing anything that escapes it. */
  private inside(...segments: string[]): string {
    const target = resolve(this.root, ...segments);
    const rel = relative(this.root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
      throw new WorkspaceError(`Path escapes the workspace root: ${segments.join("/")}`);
    }
    return target;
  }

  private checkRepo(repo: WorkspaceRepo): void {
    if (!ID_RE.test(repo.id)) throw new WorkspaceError(`Invalid repository id "${repo.id}"`);
  }

  repoDir(repo: WorkspaceRepo): string {
    this.checkRepo(repo);
    return this.inside("repos", `${repo.id}.git`);
  }

  worktreeDir(repo: WorkspaceRepo, taskKey: string): string {
    this.checkRepo(repo);
    if (!TASK_KEY_RE.test(taskKey)) throw new WorkspaceError(`Invalid task key "${taskKey}"`);
    return this.inside("worktrees", repo.id, taskKey);
  }

  private remoteUrl(repo: WorkspaceRepo): string {
    return this.options.remoteUrl?.(repo) ?? `https://github.com/${repo.owner}/${repo.name}.git`;
  }

  private git(args: string[], cwd: string, token?: string): Promise<string> {
    return runGit(args, { cwd, token, timeoutMs: this.options.gitTimeoutMs });
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, "repos"), { recursive: true });
    await mkdir(join(this.root, "worktrees"), { recursive: true });
  }

  /** Clones the repository if needed, then fetches the latest state of all branches. */
  async syncRepository(repo: WorkspaceRepo, token?: string): Promise<string> {
    const dir = this.repoDir(repo);
    if (!existsSync(join(dir, "HEAD"))) {
      await mkdir(join(this.root, "repos"), { recursive: true });
      this.log.info({ repo: repo.id }, "cloning repository");
      await runGit(["clone", "--bare", "--no-tags", this.remoteUrl(repo), dir], {
        token,
        timeoutMs: this.options.gitTimeoutMs ?? 600_000,
      });
      // Track remote branches under refs/remotes/origin/* so fetches never touch task branches.
      await this.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], dir);
      await this.git(["config", "remote.origin.tagOpt", "--no-tags"], dir);
      await this.git(["config", "core.hooksPath", "/dev/null"], dir);
    }
    await this.git(["fetch", "--prune", "origin"], dir, token);
    const head = await this.git(["rev-parse", `refs/remotes/origin/${repo.defaultBranch}`], dir);
    this.log.info({ repo: repo.id, head }, "repository synced");
    return head;
  }

  async listWorktrees(repo: WorkspaceRepo): Promise<WorktreeInfo[]> {
    const dir = this.repoDir(repo);
    if (!existsSync(dir)) return [];
    const out = await this.git(["worktree", "list", "--porcelain"], dir);
    const result: WorktreeInfo[] = [];
    for (const block of out.split("\n\n")) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path || lines.includes("bare")) continue;
      const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? null;
      result.push({
        path,
        head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
        branch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
      });
    }
    return result;
  }

  private async localBranchExists(dir: string, branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], dir);
      return true;
    } catch (err) {
      if (err instanceof GitError) return false;
      throw err;
    }
  }

  /**
   * Creates (or, after a restart, re-attaches to) the worktree for a task.
   * A new branch starts from the latest fetched default branch.
   */
  async createWorktree(
    repo: WorkspaceRepo,
    input: { taskKey: string; branch: string },
  ): Promise<WorktreeInfo> {
    validateBranchName(input.branch, repo.defaultBranch);
    const dir = this.repoDir(repo);
    if (!existsSync(join(dir, "HEAD"))) {
      throw new WorkspaceError(`Repository ${repo.id} is not cloned; call syncRepository first`);
    }
    const path = this.worktreeDir(repo, input.taskKey);

    const existing = (await this.listWorktrees(repo)).find((w) => w.path === path);
    if (existing) {
      if (existing.branch !== input.branch) {
        throw new WorkspaceError(
          `Worktree ${path} exists on branch ${existing.branch ?? "(detached)"}, expected ${input.branch}`,
        );
      }
      return existing;
    }
    if (existsSync(path)) {
      throw new WorkspaceError(`Path ${path} exists but is not a registered worktree`);
    }
    await mkdir(resolve(path, ".."), { recursive: true });

    if (await this.localBranchExists(dir, input.branch)) {
      await this.git(["worktree", "add", path, input.branch], dir);
    } else {
      await this.git(
        [
          "worktree",
          "add",
          "--no-track",
          "-b",
          input.branch,
          path,
          `refs/remotes/origin/${repo.defaultBranch}`,
        ],
        dir,
      );
    }
    this.log.info({ repo: repo.id, task: input.taskKey, branch: input.branch }, "worktree created");
    const created = (await this.listWorktrees(repo)).find((w) => w.path === path);
    if (!created) throw new WorkspaceError(`Worktree ${path} was not registered`);
    return created;
  }

  /**
   * Detached checkout of the latest default branch, for read-only analysis.
   * Replaces any previous snapshot with the same key.
   */
  async createSnapshot(repo: WorkspaceRepo, key: string): Promise<WorktreeInfo> {
    const dir = this.repoDir(repo);
    if (!existsSync(join(dir, "HEAD"))) {
      throw new WorkspaceError(`Repository ${repo.id} is not cloned; call syncRepository first`);
    }
    const path = this.worktreeDir(repo, key);
    await this.removeWorktree(repo, { taskKey: key });
    await mkdir(resolve(path, ".."), { recursive: true });
    await this.git(
      ["worktree", "add", "--detach", path, `refs/remotes/origin/${repo.defaultBranch}`],
      dir,
    );
    const created = (await this.listWorktrees(repo)).find((w) => w.path === path);
    if (!created) throw new WorkspaceError(`Snapshot ${path} was not registered`);
    return created;
  }

  /** Removes a task worktree and (by default) its local branch. Idempotent. */
  async removeWorktree(
    repo: WorkspaceRepo,
    input: { taskKey: string; branch?: string; deleteBranch?: boolean },
  ): Promise<void> {
    const dir = this.repoDir(repo);
    const path = this.worktreeDir(repo, input.taskKey);
    if (existsSync(join(dir, "HEAD"))) {
      const registered = (await this.listWorktrees(repo)).some((w) => w.path === path);
      if (registered) await this.git(["worktree", "remove", "--force", path], dir);
      await this.git(["worktree", "prune"], dir);
      if (input.branch && input.deleteBranch !== false) {
        validateBranchName(input.branch, repo.defaultBranch);
        if (await this.localBranchExists(dir, input.branch)) {
          await this.git(["branch", "-D", input.branch], dir);
        }
      }
    }
    await rm(path, { recursive: true, force: true });
    this.log.info({ repo: repo.id, task: input.taskKey }, "worktree removed");
  }
}
