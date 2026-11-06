import type { Octokit } from "octokit";
import type { RepoRef } from "./app.js";

/** Bot-managed status labels (display only; the database is the source of truth). */
export const STATUS_LABELS = {
  queued: {
    name: "ai:queued",
    color: "c5def5",
    description: "AI maintainer: allowed, waiting its turn",
  },
  running: { name: "ai:running", color: "fbca04", description: "AI maintainer: working on it" },
  waiting: {
    name: "ai:waiting-for-review",
    color: "0e8a16",
    description: "AI maintainer: waiting for a maintainer (proposal or PR)",
  },
} as const;
export type StatusLabel = keyof typeof STATUS_LABELS;
export const STATUS_LABEL_NAMES: string[] = Object.values(STATUS_LABELS).map((l) => l.name);

export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: { login: string; id: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  user: { login: string; id: number; type: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<string | { name?: string | null }>;
  user?: { login: string; id: number } | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

interface RawComment {
  id: number;
  body?: string | null;
  issue_url: string;
  user?: { login: string; id: number; type: string } | null;
  created_at: string;
  updated_at: string;
}

const params = (repo: RepoRef) => ({ owner: repo.owner, repo: repo.name });

function toIssue(raw: RawIssue): IssueSummary {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    author: raw.user ? { login: raw.user.login, id: Number(raw.user.id) } : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toComment(raw: RawComment): IssueComment {
  return {
    id: Number(raw.id),
    issueNumber: Number(raw.issue_url.split("/").pop()),
    body: raw.body ?? "",
    user: raw.user ? { login: raw.user.login, id: Number(raw.user.id), type: raw.user.type } : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Issues (not pull requests) carrying `label`, oldest first. */
export async function listIssuesWithLabel(
  octokit: Octokit,
  repo: RepoRef,
  label: string,
  state: "open" | "all" = "open",
): Promise<IssueSummary[]> {
  const raw = (await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    ...params(repo),
    state,
    labels: label,
    sort: "created",
    direction: "asc",
    per_page: 100,
  })) as RawIssue[];
  return raw
    .filter((i) => !i.pull_request)
    .map(toIssue)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
}

export async function getIssue(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
): Promise<IssueSummary> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    ...params(repo),
    issue_number: number,
  });
  return toIssue(data as RawIssue);
}

/** Who most recently added `label` to the issue (from the issue's event history). */
export async function findLabelActor(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
  label: string,
): Promise<{ login: string; id: number } | null> {
  const events = (await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/events", {
    ...params(repo),
    issue_number: number,
    per_page: 100,
  })) as Array<{
    event: string;
    label?: { name?: string };
    actor?: { login: string; id: number } | null;
  }>;
  const labeled = events.filter((e) => e.event === "labeled" && e.label?.name === label);
  const last = labeled.at(-1);
  return last?.actor ? { login: last.actor.login, id: Number(last.actor.id) } : null;
}

export async function listIssueComments(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
): Promise<IssueComment[]> {
  const raw = (await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    ...params(repo),
    issue_number: number,
    per_page: 100,
  })) as RawComment[];
  return raw.map(toComment);
}

/** All issue comments in the repository created or updated since `since`, oldest first. */
export async function listCommentsSince(
  octokit: Octokit,
  repo: RepoRef,
  since: Date,
): Promise<IssueComment[]> {
  const raw = (await octokit.paginate("GET /repos/{owner}/{repo}/issues/comments", {
    ...params(repo),
    since: since.toISOString(),
    sort: "created",
    direction: "asc",
    per_page: 100,
  })) as RawComment[];
  return raw.map(toComment);
}

/** Posts a comment; returns its id and GitHub's creation time. */
export async function createComment(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
  body: string,
): Promise<{ id: number; createdAt: string }> {
  const { data } = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...params(repo), issue_number: number, body },
  );
  return { id: Number(data.id), createdAt: data.created_at };
}

/** Creates the status labels (and the allowed label) if they do not exist yet. */
export async function ensureLabels(
  octokit: Octokit,
  repo: RepoRef,
  extra: Array<{ name: string; color: string; description: string }> = [],
): Promise<void> {
  const existing = new Set(
    (
      (await octokit.paginate("GET /repos/{owner}/{repo}/labels", {
        ...params(repo),
        per_page: 100,
      })) as Array<{
        name: string;
      }>
    ).map((l) => l.name.toLowerCase()),
  );
  for (const label of [...Object.values(STATUS_LABELS), ...extra]) {
    if (existing.has(label.name.toLowerCase())) continue;
    await octokit.request("POST /repos/{owner}/{repo}/labels", { ...params(repo), ...label });
  }
}

/**
 * Makes `status` the only status label on the issue (null removes all of them).
 * Takes the issue's current labels to avoid needless API calls.
 */
export async function setStatusLabel(
  octokit: Octokit,
  repo: RepoRef,
  number: number,
  currentLabels: string[],
  status: StatusLabel | null,
): Promise<void> {
  const wanted = status ? STATUS_LABELS[status].name : null;
  for (const name of currentLabels) {
    if (STATUS_LABEL_NAMES.includes(name) && name !== wanted) {
      await octokit
        .request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
          ...params(repo),
          issue_number: number,
          name,
        })
        .catch((err: { status?: number }) => {
          if (err.status !== 404) throw err;
        });
    }
  }
  if (wanted && !currentLabels.includes(wanted)) {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      ...params(repo),
      issue_number: number,
      labels: [wanted],
    });
  }
}
