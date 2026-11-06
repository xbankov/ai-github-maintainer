import type { Octokit } from "octokit";
import type { RepoRef } from "./app.js";

const params = (repo: RepoRef) => ({ owner: repo.owner, repo: repo.name });

export interface PullRequestInfo {
  number: number;
  nodeId: string;
  headSha: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  url: string;
}

interface RawPull {
  number: number;
  node_id: string;
  head: { sha: string };
  draft?: boolean;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  html_url: string;
}

const toPull = (p: RawPull): PullRequestInfo => ({
  number: p.number,
  nodeId: p.node_id,
  headSha: p.head.sha,
  draft: Boolean(p.draft),
  state: p.state === "closed" ? "closed" : "open",
  merged: Boolean(p.merged ?? p.merged_at),
  url: p.html_url,
});

/** The open pull request for `branch`, if any (makes PR creation idempotent). */
export async function findOpenPullRequest(
  octokit: Octokit,
  repo: RepoRef,
  branch: string,
): Promise<PullRequestInfo | undefined> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    ...params(repo),
    state: "open",
    head: `${repo.owner}:${branch}`,
    per_page: 10,
  });
  const first = (data as RawPull[])[0];
  return first ? toPull(first) : undefined;
}

export async function getPullRequest(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
): Promise<PullRequestInfo> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...params(repo),
    pull_number: number,
  });
  return toPull(data);
}

/**
 * Opens a draft pull request (CI runs, but it is not yet up for review).
 * Falls back to a normal pull request where drafts are unavailable
 * (private repositories on the free plan).
 */
export async function createPullRequest(
  octokit: Octokit,
  repo: RepoRef,
  input: { head: string; base: string; title: string; body: string },
): Promise<PullRequestInfo> {
  const create = (draft: boolean) =>
    octokit.request("POST /repos/{owner}/{repo}/pulls", { ...params(repo), ...input, draft });
  try {
    return toPull((await create(true)).data);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 422 && /draft/i.test(e.message ?? "")) {
      return toPull((await create(false)).data);
    }
    throw err;
  }
}

export async function updatePullRequestBody(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
  body: string,
): Promise<void> {
  await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...params(repo),
    pull_number: number,
    body,
  });
}

/** Closes the bot's own pull request with a comment (never used on human PRs). */
export async function closePullRequest(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
  comment: string,
): Promise<void> {
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...params(repo),
    issue_number: number,
    body: comment,
  });
  await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...params(repo),
    pull_number: number,
    state: "closed",
  });
}

/** Moves a draft pull request to "ready for review". No-op if it is not a draft. */
export async function markReadyForReview(octokit: Octokit, pr: PullRequestInfo): Promise<void> {
  if (!pr.draft) return;
  await octokit.graphql(
    `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
    { id: pr.nodeId },
  );
}

export type CiState = "none" | "pending" | "success" | "failure";

export interface CiFailure {
  name: string;
  /** GitHub Actions job id (equals the check run id), when available. */
  jobId?: number;
  url?: string;
}

export interface CiResult {
  state: CiState;
  total: number;
  failures: CiFailure[];
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Combined result of check runs and commit statuses for one commit. */
export async function getCiResult(octokit: Octokit, repo: RepoRef, sha: string): Promise<CiResult> {
  const checks = (await octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    ...params(repo),
    ref: sha,
    per_page: 100,
  })) as Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url?: string | null;
    app?: { slug?: string } | null;
  }>;
  const { data: combined } = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/status",
    {
      ...params(repo),
      ref: sha,
    },
  );
  const statuses = (combined.statuses ?? []) as Array<{
    context: string;
    state: string;
    target_url?: string | null;
  }>;

  const failures: CiFailure[] = [];
  let pending = false;
  for (const c of checks) {
    if (c.status !== "completed") pending = true;
    else if (c.conclusion && FAILED_CONCLUSIONS.has(c.conclusion)) {
      failures.push({
        name: c.name,
        url: c.html_url ?? undefined,
        ...(c.app?.slug === "github-actions" ? { jobId: c.id } : {}),
      });
    }
  }
  for (const s of statuses) {
    if (s.state === "pending") pending = true;
    else if (s.state === "failure" || s.state === "error") {
      failures.push({ name: s.context, url: s.target_url ?? undefined });
    }
  }
  const total = checks.length + statuses.length;
  const state: CiState =
    total === 0 ? "none" : pending ? "pending" : failures.length ? "failure" : "success";
  return { state, total, failures };
}

/** Tail of a GitHub Actions job log (the part with the error). */
export async function getJobLogTail(
  octokit: Octokit,
  repo: RepoRef,
  jobId: number,
  maxChars: number,
): Promise<string> {
  const res = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
    ...params(repo),
    job_id: jobId,
  });
  const text = typeof res.data === "string" ? res.data : String(res.data);
  // Strip the timestamps GitHub prefixes to every line; keep the end.
  const clean = text.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
  return clean.length > maxChars ? `[…]\n${clean.slice(-maxChars)}` : clean;
}
