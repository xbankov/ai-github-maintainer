import { App, Octokit } from "octokit";
import type { GitHubAppCredentials } from "../config/load.js";
import type { Logger } from "../logger.js";

export type RepoRef = { owner: string; name: string };

/** Repository permissions the App needs (SPEC §8: minimum necessary). */
export const REQUIRED_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

/** Permissions the App must NOT have. Their presence makes the service unready. */
export const FORBIDDEN_PERMISSIONS = [
  "administration",
  "workflows",
  "secrets",
  "actions",
  "environments",
  "organization_administration",
  "members",
] as const;

export interface AppIdentity {
  appId: number;
  slug: string;
  /** Commit author for the App's bot account. */
  botLogin: string;
  botUserId: number;
  botEmail: string;
  permissions: Record<string, string>;
}

export interface RepositoryCheck {
  repo: string;
  ok: boolean;
  installationId?: number;
  defaultBranch?: string;
  private?: boolean;
  problems: string[];
  warnings: string[];
}

export interface GitHubOptions {
  credentials: GitHubAppCredentials;
  apiUrl: string;
  logger: Logger;
  /** Injected in tests. */
  fetch?: typeof globalThis.fetch;
}

const key = (r: RepoRef) => `${r.owner}/${r.name}`.toLowerCase();
const rank = { read: 1, write: 2, admin: 3 } as Record<string, number>;

/** Checks the App's granted permissions against the least-privilege policy. */
export function checkAppPermissions(granted: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [perm, level] of Object.entries(REQUIRED_PERMISSIONS)) {
    if ((rank[granted[perm] ?? ""] ?? 0) < (rank[level] ?? 0)) {
      problems.push(`missing permission ${perm}:${level} (has ${granted[perm] ?? "none"})`);
    }
  }
  for (const perm of FORBIDDEN_PERMISSIONS) {
    if (granted[perm]) problems.push(`forbidden permission granted: ${perm}:${granted[perm]}`);
  }
  return problems;
}

/**
 * GitHub App integration: authentication, installation lookup and repository
 * access checks. Installation tokens are minted per repository with the
 * smallest permission set needed.
 */
export class GitHubApp {
  readonly app: App;
  /** Unauthenticated client for public lookups the App JWT may not perform. */
  private readonly publicOctokit: Octokit;
  private readonly installationIds = new Map<string, number>();
  private readonly log: Logger;

  constructor(private readonly options: GitHubOptions) {
    this.log = options.logger.child({ component: "github" });
    const isTest = Boolean(options.fetch);
    const OctokitWithDefaults = Octokit.defaults({
      baseUrl: options.apiUrl,
      request: options.fetch ? { fetch: options.fetch } : {},
      retry: { enabled: !isTest },
      throttle: {
        enabled: !isTest,
        onRateLimit: (
          retryAfter: number,
          opts: { method: string; url: string },
          _o: unknown,
          retryCount: number,
        ) => {
          this.log.warn(
            { retryAfter, method: opts.method, url: opts.url },
            "GitHub rate limit hit",
          );
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter: number, opts: { method: string; url: string }) => {
          this.log.warn(
            { retryAfter, method: opts.method, url: opts.url },
            "GitHub secondary rate limit hit",
          );
          return false;
        },
      },
    });
    this.publicOctokit = new OctokitWithDefaults();
    this.app = new App({
      appId: options.credentials.appId,
      privateKey: options.credentials.privateKey,
      Octokit: OctokitWithDefaults,
    });
  }

  async getIdentity(): Promise<AppIdentity> {
    const { data } = await this.app.octokit.request("GET /app");
    if (!data) throw new Error("GET /app returned no data");
    const slug = data.slug ?? String(data.id);
    const botLogin = `${slug}[bot]`;
    // App JWTs only work for /app endpoints; the bot user is public data.
    const { data: bot } = await this.publicOctokit.request("GET /users/{username}", {
      username: botLogin,
    });
    return {
      appId: data.id,
      slug,
      botLogin,
      botUserId: Number(bot.id),
      botEmail: `${bot.id}+${botLogin}@users.noreply.github.com`,
      permissions: (data.permissions ?? {}) as Record<string, string>,
    };
  }

  async getInstallationId(repo: RepoRef): Promise<number> {
    const cached = this.installationIds.get(key(repo));
    if (cached) return cached;
    const { data } = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner: repo.owner,
      repo: repo.name,
    });
    this.installationIds.set(key(repo), data.id);
    return data.id;
  }

  /** Octokit authenticated as the installation that covers `repo` (tokens refresh automatically). */
  async octokitFor(repo: RepoRef): Promise<Octokit> {
    return this.app.getInstallationOctokit(await this.getInstallationId(repo));
  }

  /**
   * Short-lived token limited to one repository and the given permissions.
   * Used for git fetch/push; never handed to the coding agent.
   */
  async createRepositoryToken(
    repo: RepoRef,
    permissions: Record<string, "read" | "write"> = { contents: "read" },
  ): Promise<{ token: string; expiresAt: string }> {
    const installationId = await this.getInstallationId(repo);
    const auth = (await this.app.octokit.auth({
      type: "installation",
      installationId,
      repositoryNames: [repo.name],
      permissions,
    })) as { token: string; expiresAt: string };
    return { token: auth.token, expiresAt: auth.expiresAt };
  }

  /** Verifies that every configured repository is reachable and matches its configuration. */
  async checkRepositories(
    repos: Array<RepoRef & { defaultBranch: string }>,
  ): Promise<RepositoryCheck[]> {
    const results: RepositoryCheck[] = [];
    const configured = new Set(repos.map(key));
    const checkedInstallations = new Set<number>();
    for (const repo of repos) {
      const result: RepositoryCheck = { repo: key(repo), ok: false, problems: [], warnings: [] };
      results.push(result);
      try {
        result.installationId = await this.getInstallationId(repo);
        const octokit = await this.octokitFor(repo);
        const { data } = await octokit.request("GET /repos/{owner}/{repo}", {
          owner: repo.owner,
          repo: repo.name,
        });
        result.defaultBranch = data.default_branch;
        result.private = data.private;
        if (data.archived) result.problems.push("repository is archived");
        if (data.default_branch !== repo.defaultBranch) {
          result.problems.push(
            `default branch is "${data.default_branch}" but config says "${repo.defaultBranch}"`,
          );
        }
        if (!data.private) {
          result.warnings.push(
            "repository is public: anyone can open issues; only issues a maintainer labels are processed",
          );
        }
        if (!checkedInstallations.has(result.installationId)) {
          checkedInstallations.add(result.installationId);
          const visible = await octokit.paginate("GET /installation/repositories", {
            per_page: 100,
          });
          const extra = visible
            .map((r) => r.full_name.toLowerCase())
            .filter((n) => !configured.has(n));
          if (extra.length) {
            result.warnings.push(
              `App installation can access unconfigured repositories (ignored): ${extra.join(", ")}`,
            );
          }
        }
        result.ok = result.problems.length === 0;
      } catch (err) {
        const status = (err as { status?: number }).status;
        result.problems.push(
          status === 404
            ? "GitHub App is not installed on this repository (or it does not exist)"
            : `GitHub request failed: ${(err as Error).message}`,
        );
      }
      for (const w of result.warnings) this.log.warn({ repo: result.repo }, w);
      for (const p of result.problems) this.log.error({ repo: result.repo }, p);
    }
    return results;
  }

  /** Resolves logins to immutable numeric user ids (renames cannot grant authority). */
  async resolveUserIds(logins: string[], via: RepoRef): Promise<Map<string, number>> {
    const octokit = await this.octokitFor(via);
    const ids = new Map<string, number>();
    for (const login of logins) {
      const { data } = await octokit.request("GET /users/{username}", { username: login });
      ids.set(login.toLowerCase(), Number(data.id));
    }
    return ids;
  }
}
