import { and, eq, inArray } from "drizzle-orm";
import { repositories, settings, tasks } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import {
  createComment,
  ensureLabels,
  findLabelActor,
  getIssue,
  listCommentsSince,
  listIssuesWithLabel,
  setStatusLabel,
  STATUS_LABELS,
  type IssueSummary,
} from "../github/issues.js";
import { canTransition } from "../orchestrator/state-machine.js";
import type { Job } from "../workers/queue.js";
import { enqueue, hasActiveJob } from "../workers/queue.js";
import { ANALYZE_JOB, analyzeDedupeKey } from "./analysis.js";
import { handleCommandComment, unfinishedCommands } from "./approvals.js";
import type { OrchestratorContext, Task } from "./context.js";
import { issueFingerprint } from "./proposal.js";

export const SYNC_JOB = "sync-repository";
export const syncDedupeKey = (repositoryId: string) => `sync:${repositoryId}`;

/** States before a pull request exists (Milestone 2 scope). */
const PRE_PR_STATES = [
  "DISCOVERED",
  "ANALYZING",
  "AWAITING_APPROVAL",
  "REJECTED",
  "APPROVED",
  "FAILED",
] as const;
/** States that occupy one of the `issue_batch_size` analysis slots. */
const SLOT_STATES = ["DISCOVERED", "ANALYZING", "AWAITING_APPROVAL"] as const;

/** Overlap between polls so comments created during a poll are never missed. */
const COMMENT_OVERLAP_MS = 2 * 60_000;
const FIRST_POLL_LOOKBACK_MS = 60 * 60_000;

export interface SyncResult {
  commands: number;
  eligible: number;
  started: number[];
  abandoned: number[];
  reanalysed: number[];
  labelsCleared: number[];
}

/** One polling cycle for one repository. */
export async function syncRepository(
  ctx: OrchestratorContext,
  job: Job,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const repositoryId = (job.payload as { repositoryId: string }).repositoryId;
  const repo = ctx.repository(repositoryId);
  const ref = ctx.ref(repo);
  const log = ctx.logger.child({ component: "sync", repo: repo.id });
  const octokit = await ctx.github.octokitFor(ref);
  const result: SyncResult = {
    commands: 0,
    eligible: 0,
    started: [],
    abandoned: [],
    reanalysed: [],
    labelsCleared: [],
  };
  const allowedLabel = ctx.config.file.github.allowed_label;

  if (!ctx.labelsEnsured.has(repo.id)) {
    await ensureLabels(octokit, ref, [
      {
        name: allowedLabel,
        color: "5319e7",
        description: "AI maintainer: a maintainer allowed AI work on this issue",
      },
    ]);
    ctx.labelsEnsured.add(repo.id);
  }

  // 1. Commands: first resume any that did not finish, then new comments since the last poll.
  for (const comment of unfinishedCommands(ctx, repo.id)) {
    if (await handleCommandComment(ctx, repo.id, comment)) result.commands++;
  }
  const cursorKey = `comments-cursor:${repo.id}`;
  const pollStarted = new Date();
  const cursorRow = ctx.db.select().from(settings).where(eq(settings.key, cursorKey)).get();
  const since = cursorRow
    ? new Date(new Date(cursorRow.value as string).getTime() - COMMENT_OVERLAP_MS)
    : new Date(pollStarted.getTime() - FIRST_POLL_LOOKBACK_MS);
  const identity = await ctx.identity();
  for (const comment of await listCommentsSince(octokit, ref, since)) {
    signal?.throwIfAborted();
    if (comment.user?.type === "Bot" || comment.user?.login === identity.botLogin) continue;
    if (await handleCommandComment(ctx, repo.id, comment)) result.commands++;
  }
  ctx.db
    .insert(settings)
    .values({ key: cursorKey, value: pollStarted.toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: pollStarted.toISOString(), updatedAt: new Date() },
    })
    .run();

  // 2. Issues a maintainer has allowed.
  const maintainers = await ctx.maintainers(ref);
  const eligible = new Map<number, IssueSummary>();
  for (const issue of await listIssuesWithLabel(octokit, ref, allowedLabel)) {
    if (issue.author?.login === identity.botLogin) continue; // own feature proposals are never auto-processed
    const cacheKey = `${repo.id}#${issue.number}`;
    let cached = ctx.labelActorCache.get(cacheKey);
    if (!cached || cached.updatedAt !== issue.updatedAt) {
      const actor = await findLabelActor(octokit, ref, issue.number, allowedLabel);
      cached = { updatedAt: issue.updatedAt, actorId: actor?.id ?? null };
      ctx.labelActorCache.set(cacheKey, cached);
      if (actor && !maintainers.has(actor.id)) {
        log.warn(
          { issue: issue.number, by: actor.login },
          "allowed label added by a non-maintainer; ignored",
        );
      }
    }
    if (cached.actorId !== null && maintainers.has(cached.actorId)) {
      eligible.set(issue.number, issue);
    }
  }
  result.eligible = eligible.size;
  signal?.throwIfAborted();

  // 3. Reconcile existing tasks with the current issue state.
  const live = ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.repositoryId, repo.id), inArray(tasks.status, [...PRE_PR_STATES])))
    .all();
  for (const task of live) {
    const issue = eligible.get(task.githubIssueNumber);
    if (!issue) {
      if (await stopTask(ctx, task, allowedLabel)) result.abandoned.push(task.githubIssueNumber);
      continue;
    }
    const changed =
      task.issueFingerprint !== null && task.issueFingerprint !== issueFingerprint(issue);
    if (changed && canTransition(task.status, "ANALYZING", "issue_changed")) {
      const analysing = transitionTask(ctx.db, {
        taskId: task.id,
        to: "ANALYZING",
        trigger: "issue_changed",
        patch: { approvedVersion: null },
      });
      enqueueAnalysis(ctx, task);
      await createComment(
        octokit,
        ref,
        issue.number,
        "🤖 The issue changed, so it will be analysed again. Any approval of the previous proposal no longer applies.",
      );
      await ctx.syncStatusLabel(analysing, issue.labels);
      result.reanalysed.push(issue.number);
      continue;
    }
    // Recovery: work that should be in progress but has no job (e.g. after a crash),
    // including a stored proposal whose publication was interrupted.
    const unpublished =
      task.status === "AWAITING_APPROVAL" && !ctx.latestProposal(task.id)?.publishedAt;
    if (
      (task.status === "DISCOVERED" || task.status === "ANALYZING" || unpublished) &&
      !hasActiveJob(ctx.db, analyzeDedupeKey(task.id))
    ) {
      enqueueAnalysis(ctx, task);
    }
    // Display: make the status label match the task (repairs interrupted label updates).
    if (!hasActiveJob(ctx.db, analyzeDedupeKey(task.id))) {
      await ctx.syncStatusLabel(task, issue.labels);
    }
  }

  // 4. Start new tasks for the oldest eligible issues, within the batch limit.
  const liveByIssue = new Map(
    ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.repositoryId, repo.id), inArray(tasks.status, [...PRE_PR_STATES])))
      .all()
      .map((t) => [t.githubIssueNumber, t]),
  );
  let slots =
    ctx.config.file.discovery.issue_batch_size -
    [...liveByIssue.values()].filter((t) => (SLOT_STATES as readonly string[]).includes(t.status))
      .length;
  for (const issue of eligible.values()) {
    if (liveByIssue.has(issue.number)) continue;
    if (slots <= 0) {
      await setStatusLabel(octokit, ref, issue.number, issue.labels, "queued");
      continue;
    }
    const task = ctx.db
      .insert(tasks)
      .values({
        repositoryId: repo.id,
        type: "issue",
        githubIssueNumber: issue.number,
        status: "DISCOVERED",
      })
      .returning()
      .get();
    ctx.audit({
      action: "task.discovered",
      repositoryId: repo.id,
      taskId: task.id,
      details: { issue: issue.number },
    });
    enqueueAnalysis(ctx, task);
    await setStatusLabel(octokit, ref, issue.number, issue.labels, "queued");
    result.started.push(issue.number);
    slots--;
  }

  // 5. Remove status labels from issues the maintainer no longer works on
  //    (e.g. deferred issues that lost the allowed label or were closed).
  const tracked = new Set(
    ctx.db
      .select({ n: tasks.githubIssueNumber })
      .from(tasks)
      .where(and(eq(tasks.repositoryId, repo.id), inArray(tasks.status, [...PRE_PR_STATES])))
      .all()
      .map((t) => t.n),
  );
  const seen = new Set<number>();
  for (const status of Object.values(STATUS_LABELS)) {
    for (const issue of await listIssuesWithLabel(octokit, ref, status.name, "all")) {
      if (seen.has(issue.number)) continue;
      seen.add(issue.number);
      const wanted =
        issue.state === "open" && (tracked.has(issue.number) || eligible.has(issue.number));
      if (!wanted) {
        await setStatusLabel(octokit, ref, issue.number, issue.labels, null);
        result.labelsCleared.push(issue.number);
      }
    }
  }

  ctx.db
    .update(repositories)
    .set({ lastDiscoveryAt: new Date() })
    .where(eq(repositories.id, repo.id))
    .run();
  const busy =
    result.commands ||
    result.started.length ||
    result.abandoned.length ||
    result.reanalysed.length ||
    result.labelsCleared.length;
  if (busy) log.info(result, "sync complete");
  else log.debug(result, "sync complete");
  return result;
}

function enqueueAnalysis(ctx: OrchestratorContext, task: Task) {
  enqueue(ctx.db, {
    type: ANALYZE_JOB,
    payload: { taskId: task.id },
    repositoryId: task.repositoryId,
    dedupeKey: analyzeDedupeKey(task.id),
    maxAttempts: 3,
  });
}

/** The issue was closed or lost its allowed label: stop working on it. */
async function stopTask(
  ctx: OrchestratorContext,
  task: Task,
  allowedLabel: string,
): Promise<boolean> {
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  const trigger = issue.state === "closed" ? "issue_closed" : "manual_abandon";
  if (!canTransition(task.status, "ABANDONED", trigger)) return false;
  transitionTask(ctx.db, {
    taskId: task.id,
    to: "ABANDONED",
    trigger,
    details: {
      reason: issue.state === "closed" ? "issue closed" : `label ${allowedLabel} removed`,
    },
  });
  await setStatusLabel(octokit, ref, issue.number, issue.labels, null);
  if (issue.state === "open") {
    await createComment(
      octokit,
      ref,
      issue.number,
      `🤖 Stopped: the \`${allowedLabel}\` label was removed (or not added by a maintainer). Add it again to restart.`,
    );
  }
  return true;
}
