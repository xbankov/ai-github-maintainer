import type { Db } from "./database/client.js";
import { pingDatabase } from "./database/client.js";
import { getKillSwitch, type KillSwitchState } from "./database/settings.js";
import type { GitHubApp, RepositoryCheck } from "./github/app.js";
import { checkAppPermissions } from "./github/app.js";
import type { OpenCode } from "./opencode/client.js";

export interface ComponentStatus {
  ok: boolean;
  checkedAt: string | null;
  problems: string[];
  warnings?: string[];
  details?: unknown;
}

export interface ReadinessReport {
  ready: boolean;
  killSwitch: KillSwitchState;
  components: {
    database: ComponentStatus;
    opencode: ComponentStatus;
    github: ComponentStatus;
  };
}

interface Cached {
  status: ComponentStatus;
  expiresAt: number;
}

export interface HealthMonitorOptions {
  db: Db;
  envPaused: boolean;
  opencode: OpenCode;
  github: GitHubApp | null;
  repositories: Array<{ owner: string; name: string; defaultBranch: string; enabled: boolean }>;
  /** How long external checks are cached, so /readyz cannot hammer GitHub. */
  ttlMs?: { opencode: number; github: number };
  now?: () => number;
}

/** Aggregates dependency health for /readyz and startup logs. */
export class HealthMonitor {
  private cache = new Map<"opencode" | "github", Cached>();
  private inflight = new Map<"opencode" | "github", Promise<ComponentStatus>>();
  private readonly now: () => number;

  constructor(private readonly options: HealthMonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private database(): ComponentStatus {
    try {
      pingDatabase(this.options.db);
      return { ok: true, checkedAt: this.stamp(), problems: [] };
    } catch (err) {
      return {
        ok: false,
        checkedAt: this.stamp(),
        problems: [`database: ${(err as Error).message}`],
      };
    }
  }

  private async cached(
    name: "opencode" | "github",
    ttl: number,
    run: () => Promise<ComponentStatus>,
    force: boolean,
  ): Promise<ComponentStatus> {
    const hit = this.cache.get(name);
    if (!force && hit && hit.expiresAt > this.now()) return hit.status;
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const promise = run()
      .catch((err: unknown): ComponentStatus => ({
        ok: false,
        checkedAt: this.stamp(),
        problems: [(err as Error).message],
      }))
      .then((status) => {
        // Failures are re-checked sooner than successes.
        this.cache.set(name, {
          status,
          expiresAt: this.now() + (status.ok ? ttl : Math.min(ttl, 15_000)),
        });
        return status;
      })
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, promise);
    return promise;
  }

  private async checkOpenCode(): Promise<ComponentStatus> {
    const result = await this.options.opencode.check();
    return {
      ok: result.ok,
      checkedAt: this.stamp(),
      problems: result.problems,
      details: { agents: result.agents },
    };
  }

  private async checkGitHub(): Promise<ComponentStatus> {
    const github = this.options.github;
    if (!github) {
      return {
        ok: false,
        checkedAt: this.stamp(),
        problems: [
          "GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in .env)",
        ],
      };
    }
    const identity = await github.getIdentity();
    const problems = checkAppPermissions(identity.permissions);
    const enabled = this.options.repositories.filter((r) => r.enabled);
    const repos: RepositoryCheck[] = await github.checkRepositories(enabled);
    for (const r of repos) problems.push(...r.problems.map((p) => `${r.repo}: ${p}`));
    return {
      ok: problems.length === 0,
      checkedAt: this.stamp(),
      problems,
      warnings: repos.flatMap((r) => r.warnings.map((w) => `${r.repo}: ${w}`)),
      details: {
        app: identity.slug,
        repositories: repos.map((r) => ({ repo: r.repo, ok: r.ok, private: r.private })),
      },
    };
  }

  async report(force = false): Promise<ReadinessReport> {
    const ttl = this.options.ttlMs ?? { opencode: 30_000, github: 300_000 };
    const database = this.database();
    const [opencode, github] = await Promise.all([
      this.cached("opencode", ttl.opencode, () => this.checkOpenCode(), force),
      this.cached("github", ttl.github, () => this.checkGitHub(), force),
    ]);
    let killSwitch: KillSwitchState;
    try {
      killSwitch = getKillSwitch(this.options.db, this.options.envPaused);
    } catch {
      killSwitch = { paused: true, source: null, reason: "kill switch state unreadable" };
    }
    return {
      ready: database.ok && opencode.ok && github.ok,
      killSwitch,
      components: { database, opencode, github },
    };
  }
}
