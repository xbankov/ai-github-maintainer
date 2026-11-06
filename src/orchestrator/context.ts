import { and, desc, eq, notInArray } from "drizzle-orm";
import type { AppConfig } from "../config/load.js";
import type { RepositoryConfig } from "../config/schema.js";
import type { Db } from "../database/client.js";
import { auditLog, proposals, tasks } from "../database/schema.js";
import type { AppIdentity, GitHubApp } from "../github/app.js";
import { getIssue, setStatusLabel, type StatusLabel } from "../github/issues.js";
import type { Logger } from "../logger.js";
import type { OpenCode } from "../opencode/client.js";
import type { WorkspaceManager, WorkspaceRepo } from "../workspace/manager.js";

export type Task = typeof tasks.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;

/** Everything the workflow handlers need. */
export class OrchestratorContext {
  /** Who added the allowed label, cached per issue update (unchanged issues cost no API call). */
  readonly labelActorCache = new Map<string, { updatedAt: string; actorId: number | null }>();
  /** Repositories whose status labels have been created this process. */
  readonly labelsEnsured = new Set<string>();
  private identityCache: { value: AppIdentity; at: number } | undefined;
  private maintainerCache: { ids: Map<number, string>; at: number } | undefined;

  constructor(
    readonly config: AppConfig,
    readonly db: Db,
    readonly github: GitHubApp,
    readonly opencode: OpenCode,
    readonly workspace: WorkspaceManager,
    readonly logger: Logger,
  ) {}

  repository(id: string): RepositoryConfig {
    const repo = this.config.file.repositories.find((r) => r.id === id);
    if (!repo) throw new Error(`Unknown repository "${id}"`);
    return repo;
  }

  ref(repo: RepositoryConfig) {
    return { owner: repo.owner, name: repo.name };
  }

  workspaceRepo(repo: RepositoryConfig): WorkspaceRepo {
    return { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.default_branch };
  }

  /** The App's bot account (cached for an hour). */
  async identity(): Promise<AppIdentity> {
    if (!this.identityCache || Date.now() - this.identityCache.at > 3_600_000) {
      this.identityCache = { value: await this.github.getIdentity(), at: Date.now() };
    }
    return this.identityCache.value;
  }

  /**
   * Maintainers by immutable GitHub user id → login (cached for an hour).
   * Resolved through the installation of `via` — the repository being worked on —
   * so a repository without the App installed cannot block the others.
   */
  async maintainers(via: { owner: string; name: string }): Promise<Map<number, string>> {
    if (!this.maintainerCache || Date.now() - this.maintainerCache.at > 3_600_000) {
      const byLogin = await this.github.resolveUserIds(
        this.config.file.github.authorized_users,
        via,
      );
      const ids = new Map<number, string>();
      for (const [login, id] of byLogin) ids.set(id, login);
      this.maintainerCache = { ids, at: Date.now() };
    }
    return this.maintainerCache.ids;
  }

  /** The live (not COMPLETED/ABANDONED) task for an issue, if any. */
  liveTask(repositoryId: string, issueNumber: number): Task | undefined {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.repositoryId, repositoryId),
          eq(tasks.githubIssueNumber, issueNumber),
          notInArray(tasks.status, ["COMPLETED", "ABANDONED"]),
        ),
      )
      .get();
  }

  task(id: number): Task | undefined {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  latestProposal(taskId: number): ProposalRow | undefined {
    return this.db
      .select()
      .from(proposals)
      .where(eq(proposals.taskId, taskId))
      .orderBy(desc(proposals.version))
      .limit(1)
      .get();
  }

  /** The status label a task should show on GitHub (display only). */
  statusLabelFor(task: Task): StatusLabel | null {
    switch (task.status) {
      case "DISCOVERED":
      case "APPROVED":
        return "queued";
      case "ANALYZING":
        return "running";
      case "AWAITING_APPROVAL":
        return this.latestProposal(task.id)?.publishedAt ? "waiting" : "running";
      default:
        return null;
    }
  }

  /** Makes the issue's status label match the task's current state. */
  async syncStatusLabel(task: Task, currentLabels?: string[]): Promise<void> {
    const ref = this.ref(this.repository(task.repositoryId));
    const octokit = await this.github.octokitFor(ref);
    const labels = currentLabels ?? (await getIssue(octokit, ref, task.githubIssueNumber)).labels;
    await setStatusLabel(octokit, ref, task.githubIssueNumber, labels, this.statusLabelFor(task));
  }

  audit(entry: {
    action: string;
    repositoryId?: string | null;
    taskId?: number | null;
    actor?: string;
    details?: Record<string, unknown>;
  }): void {
    this.db
      .insert(auditLog)
      .values({
        action: entry.action,
        repositoryId: entry.repositoryId ?? null,
        taskId: entry.taskId ?? null,
        actor: entry.actor ?? "system",
        details: entry.details ?? null,
      })
      .run();
  }
}
