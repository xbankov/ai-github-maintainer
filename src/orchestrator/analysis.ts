import { and, eq } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { proposals, tasks } from "../database/schema.js";
import { transitionTask } from "../database/tasks.js";
import { createComment, getIssue, listIssueComments, setStatusLabel } from "../github/issues.js";
import type { Job } from "../workers/queue.js";
import { PermanentJobError } from "../workers/processor.js";
import type { OrchestratorContext, Task } from "./context.js";
import { buildAnalysisPrompt, buildProposalJsonPrompt } from "./prompts.js";
import {
  issueFingerprint,
  parseProposal,
  PROPOSAL_MARKER,
  proposalFingerprint,
  renderProposalComment,
  type Proposal,
} from "./proposal.js";

export const ANALYZE_JOB = "analyze-issue";

export interface AnalyzePayload {
  taskId: number;
  /** Set for /ai revise. */
  revision?: { instructions: string; by: string };
}

export const analyzeDedupeKey = (taskId: number) => `analyze:${taskId}`;

const JSON_ATTEMPTS = 3;

/**
 * Analyses one issue with the read-only OpenCode agent and publishes a new
 * proposal version. Safe to retry: database state is written before the
 * comment is posted, and an already-posted comment is found by its marker.
 */
export async function analyzeIssue(ctx: OrchestratorContext, job: Job): Promise<void> {
  const payload = job.payload as AnalyzePayload;
  let task = ctx.task(payload.taskId);
  if (!task) throw new PermanentJobError(`task ${payload.taskId} not found`);
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const log = ctx.logger.child({
    component: "analysis",
    taskId: task.id,
    issue: task.githubIssueNumber,
  });
  const octokit = await ctx.github.octokitFor(ref);

  // A proposal was stored but publishing it was interrupted: only publish.
  if (task.status === "AWAITING_APPROVAL") {
    const latest = ctx.latestProposal(task.id);
    if (latest && !latest.githubCommentId)
      await publish(ctx, task, latest.version, latest.content as Proposal);
    return;
  }
  if (task.status !== "DISCOVERED" && task.status !== "ANALYZING") {
    log.info({ status: task.status }, "nothing to analyse in this state");
    return;
  }
  if (task.status === "DISCOVERED") {
    task = transitionTask(ctx.db, {
      taskId: task.id,
      to: "ANALYZING",
      trigger: "analysis_started",
    });
  }

  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, "running");
  const identity = await ctx.identity();
  const comments = (await listIssueComments(octokit, ref, issue.number)).filter(
    (c) => c.user?.type !== "Bot" && c.user?.login !== identity.botLogin,
  );
  const fingerprint = issueFingerprint(issue);
  const previous = ctx.latestProposal(task.id);

  // Read-only snapshot of the latest default branch for the agent to inspect.
  const wsRepo = ctx.workspaceRepo(repo);
  const snapshotKey = `analysis-${task.id}`;
  const { token } = await ctx.github.createRepositoryToken(ref, { contents: "read" });
  await ctx.workspace.syncRepository(wsRepo, token);
  const snapshot = await ctx.workspace.createSnapshot(wsRepo, snapshotKey);

  const settings = opencodeSettingsFor(ctx.config, repo);
  const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
  let sessionId: string | undefined;
  let proposal: Proposal;
  try {
    sessionId = await ctx.opencode.createSession({
      directory: snapshot.path,
      title: `${repo.id}#${issue.number} analysis`,
      agent: settings.analysisAgent,
      model: settings.model,
    });
    await ctx.opencode.run(
      sessionId,
      buildAnalysisPrompt({
        repository: `${repo.owner}/${repo.name}`,
        instructions: repo.instructions,
        issue,
        comments,
        revision: payload.revision
          ? {
              ...payload.revision,
              previous: previous ? (previous.content as Proposal) : undefined,
            }
          : undefined,
      }),
      timeoutMs,
    );
    let lastError: string | undefined;
    let parsed: Proposal | undefined;
    for (let attempt = 1; attempt <= JSON_ATTEMPTS && !parsed; attempt++) {
      const reply = await ctx.opencode.generate(
        sessionId,
        buildProposalJsonPrompt(lastError),
        timeoutMs,
      );
      const result = parseProposal(reply);
      if (result.ok) parsed = result.proposal;
      else {
        lastError = result.error;
        log.warn({ attempt, error: result.error }, "structured answer rejected");
      }
    }
    if (!parsed) throw new Error(`model did not return a valid proposal: ${lastError}`);
    proposal = parsed;
  } finally {
    if (sessionId) await ctx.opencode.deleteSession(sessionId).catch(() => undefined);
    await ctx.workspace.removeWorktree(wsRepo, { taskKey: snapshotKey }).catch(() => undefined);
  }

  // The task may have been stopped (label removed, issue closed) while the agent worked.
  const current = ctx.task(task.id);
  if (current?.status !== "ANALYZING") {
    log.info({ status: current?.status }, "task changed during analysis; result discarded");
    return;
  }

  // Persist first, publish second.
  const fp = proposalFingerprint(proposal);
  const unchanged = previous && previous.fingerprint === fp;
  const version = unchanged ? previous.version : current.proposalVersion + 1;
  const taskId = current.id;
  ctx.db.transaction((tx) => {
    if (!unchanged) {
      tx.update(proposals)
        .set({ status: "superseded" })
        .where(and(eq(proposals.taskId, taskId), eq(proposals.status, "pending")))
        .run();
      tx.insert(proposals)
        .values({ taskId, version, content: proposal, fingerprint: fp, status: "pending" })
        .run();
    }
    tx.update(tasks).set({ lastError: null }).where(eq(tasks.id, taskId)).run();
  });
  task = transitionTask(ctx.db, {
    taskId,
    to: "AWAITING_APPROVAL",
    trigger: "analysis_completed",
    patch: { proposalVersion: version, approvedVersion: null, issueFingerprint: fingerprint },
    details: { version, unchanged: Boolean(unchanged), revision: Boolean(payload.revision) },
  });
  log.info({ version, unchanged: Boolean(unchanged) }, "analysis complete");

  if (unchanged) {
    await createComment(
      octokit,
      ref,
      issue.number,
      `🤖 Re-analysis produced the same proposal (v${version}); it still applies. ` +
        "Any previous approval has been reset — reply `/ai approve` to approve it again.",
    );
    const fresh = await getIssue(octokit, ref, issue.number);
    await setStatusLabel(octokit, ref, issue.number, fresh.labels, "waiting");
    return;
  }
  await publish(ctx, task, version, proposal);
}

/** Posts (or finds an already-posted) proposal comment and records its id. */
async function publish(ctx: OrchestratorContext, task: Task, version: number, proposal: Proposal) {
  const repo = ctx.repository(task.repositoryId);
  const ref = ctx.ref(repo);
  const octokit = await ctx.github.octokitFor(ref);
  const identity = await ctx.identity();
  const existing = (await listIssueComments(octokit, ref, task.githubIssueNumber)).find((c) => {
    const m = PROPOSAL_MARKER.exec(c.body);
    return (
      c.user?.login === identity.botLogin &&
      m &&
      Number(m[1]) === task.id &&
      Number(m[2]) === version
    );
  });
  const commentId =
    existing?.id ??
    (await createComment(
      octokit,
      ref,
      task.githubIssueNumber,
      renderProposalComment({ taskId: task.id, version, proposal }),
    ));
  ctx.db
    .update(proposals)
    .set({ githubCommentId: commentId })
    .where(and(eq(proposals.taskId, task.id), eq(proposals.version, version)))
    .run();
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, "waiting");
  ctx.audit({
    action: "proposal.published",
    repositoryId: task.repositoryId,
    taskId: task.id,
    details: { version, commentId },
  });
}

/** Called when an analysis job has failed for the last time. */
export async function onAnalysisDead(ctx: OrchestratorContext, job: Job): Promise<void> {
  const payload = job.payload as AnalyzePayload;
  const task = ctx.task(payload.taskId);
  if (!task || task.status !== "ANALYZING") return;
  transitionTask(ctx.db, {
    taskId: task.id,
    to: "FAILED",
    trigger: "analysis_failed",
    patch: { lastError: job.lastError ?? "analysis failed" },
  });
  const ref = ctx.ref(ctx.repository(task.repositoryId));
  const octokit = await ctx.github.octokitFor(ref);
  const issue = await getIssue(octokit, ref, task.githubIssueNumber);
  await setStatusLabel(octokit, ref, issue.number, issue.labels, null);
  await createComment(
    octokit,
    ref,
    issue.number,
    `🤖 The analysis failed after ${job.attempts} attempts. A maintainer can retry with \`/ai revise <guidance>\`.`,
  );
}
