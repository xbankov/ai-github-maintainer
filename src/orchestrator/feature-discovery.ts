import { and, eq, notInArray } from "drizzle-orm";
import { opencodeSettingsFor } from "../config/load.js";
import { featureFingerprints, tasks } from "../database/schema.js";
import { createIssue, listIssuesWithLabel, listOpenIssueTitles } from "../github/issues.js";
import type { Job } from "../workers/queue.js";
import { enqueue } from "../workers/queue.js";
import type { OrchestratorContext } from "./context.js";
import { buildFeatureJsonPrompt, buildFeaturePrompt } from "./prompts.js";
import {
  featureFingerprint,
  featureListSchema,
  parseStructured,
  renderFeatureIssue,
  type Feature,
} from "./proposal.js";

/**
 * Feature discovery (SPEC §2.6): when a repository is idle, the agent studies
 * it and opens up to `feature_suggestions` issues labelled `ai:proposal`.
 * Proposals are never processed by themselves — a maintainer adds `ai:allowed`
 * to one to start working on it — so they cannot cause a processing loop.
 */
export const FEATURE_JOB = "discover-features";
export const featureDedupeKey = (repositoryId: string) => `features:${repositoryId}`;

const JSON_ATTEMPTS = 3;

export function enqueueFeatureDiscovery(
  ctx: { db: OrchestratorContext["db"] },
  repositoryId: string,
  delayMs = 0,
) {
  enqueue(ctx.db, {
    type: FEATURE_JOB,
    payload: { repositoryId },
    repositoryId,
    dedupeKey: featureDedupeKey(repositoryId),
    maxAttempts: 2,
    availableAt: new Date(Date.now() + delayMs),
  });
}

export async function discoverFeatures(
  ctx: OrchestratorContext,
  job: Job,
  signal: AbortSignal,
): Promise<{ created: number[]; skipped: string[] }> {
  const { repositoryId } = job.payload as { repositoryId: string };
  const repo = ctx.repository(repositoryId);
  const ref = ctx.ref(repo);
  const log = ctx.logger.child({ component: "features", repo: repo.id });
  const octokit = await ctx.github.octokitFor(ref);
  const result = { created: [] as number[], skipped: [] as string[] };
  const { allowed_label: allowedLabel, proposal_label: proposalLabel } = ctx.config.file.github;

  // Only when idle: no task in progress and no issue waiting to be worked on.
  const isIdle = async () =>
    !ctx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.repositoryId, repo.id),
          notInArray(tasks.status, ["COMPLETED", "ABANDONED", "REJECTED"]),
        ),
      )
      .get() && !(await listIssuesWithLabel(octokit, ref, allowedLabel)).length;
  if (!(await isIdle())) return result;

  // Back-pressure: never more than `feature_suggestions` open proposals.
  const open = await listIssuesWithLabel(octokit, ref, proposalLabel);
  const budget = ctx.config.file.discovery.feature_suggestions - open.length;
  if (budget <= 0) return result;

  const known = new Set(
    ctx.db
      .select({ fp: featureFingerprints.fingerprint })
      .from(featureFingerprints)
      .where(eq(featureFingerprints.repositoryId, repo.id))
      .all()
      .map((r) => r.fp),
  );
  const openTitles = await listOpenIssueTitles(octokit, ref);
  for (const t of openTitles) known.add(featureFingerprint(t));
  const previousTitles = [
    ...ctx.db
      .select({ title: featureFingerprints.title })
      .from(featureFingerprints)
      .where(eq(featureFingerprints.repositoryId, repo.id))
      .all()
      .map((r) => r.title),
    ...openTitles,
  ].slice(-80);

  // Read-only snapshot and a kept session named after the date, visible in the OpenCode UI.
  const wsRepo = ctx.workspaceRepo(repo);
  const { token } = await ctx.github.createRepositoryToken(ref, { contents: "read" });
  await ctx.workspace.syncRepository(wsRepo, token);
  const snapshot = await ctx.workspace.createSnapshot(wsRepo, "features");
  const settings = opencodeSettingsFor(ctx.config, repo);
  const timeoutMs = ctx.config.file.limits.analysis_timeout_minutes * 60_000;
  let features: Feature[] = [];
  try {
    const sessionId = await ctx.opencode.createSession({
      directory: snapshot.path,
      title: `${repo.id} — feature ideas ${new Date().toISOString().slice(0, 10)}`,
      agent: settings.analysisAgent,
      model: settings.model,
    });
    await ctx.opencode.run(
      sessionId,
      buildFeaturePrompt({
        repository: `${repo.owner}/${repo.name}`,
        count: budget,
        previous: previousTitles,
        instructions: repo.instructions,
      }),
      timeoutMs,
      signal,
    );
    let error: string | undefined;
    for (let attempt = 1; attempt <= JSON_ATTEMPTS && !features.length; attempt++) {
      const parsed = parseStructured(
        await ctx.opencode.generate(
          sessionId,
          buildFeatureJsonPrompt(budget, error),
          timeoutMs,
          signal,
        ),
        featureListSchema,
      );
      if (parsed.ok) features = parsed.value.features;
      else error = parsed.error;
    }
  } finally {
    await ctx.workspace.removeWorktree(wsRepo, { taskKey: "features" }).catch(() => undefined);
  }
  signal.throwIfAborted();
  // Work may have started while the agent was thinking: then publish nothing.
  if (!(await isIdle())) {
    log.info("repository became busy; feature ideas discarded");
    return result;
  }

  for (const feature of features) {
    if (result.created.length >= budget) break;
    const fp = featureFingerprint(feature.title);
    if (known.has(fp)) {
      result.skipped.push(feature.title);
      continue;
    }
    // Remember the idea before publishing it, so a crash can never lose the duplicate history.
    ctx.db
      .insert(featureFingerprints)
      .values({ repositoryId: repo.id, fingerprint: fp, title: feature.title })
      .onConflictDoNothing()
      .run();
    const number = await createIssue(octokit, ref, {
      title: feature.title,
      body: renderFeatureIssue(feature),
      labels: [proposalLabel],
    });
    ctx.db
      .update(featureFingerprints)
      .set({ githubIssueNumber: number })
      .where(
        and(eq(featureFingerprints.repositoryId, repo.id), eq(featureFingerprints.fingerprint, fp)),
      )
      .run();
    known.add(fp);
    result.created.push(number);
  }
  ctx.audit({ action: "features.suggested", repositoryId: repo.id, details: result });
  log.info(result, "feature discovery finished");
  return result;
}
