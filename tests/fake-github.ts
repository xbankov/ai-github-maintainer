import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mockFetch } from "./helpers.js";

export const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export interface FakeUser {
  login: string;
  id: number;
  type: "User" | "Bot";
}

export const USERS = {
  xbankov: { login: "xbankov", id: 1, type: "User" },
  vlado: { login: "VladoBaca", id: 2, type: "User" },
  stranger: { login: "stranger", id: 3, type: "User" },
  bot: { login: "maint[bot]", id: 999, type: "Bot" },
} satisfies Record<string, FakeUser>;

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  user: FakeUser;
  created_at: string;
  updated_at: string;
  pull_request?: object;
  events: Array<{ event: string; label: { name: string }; actor: FakeUser; created_at: string }>;
}

interface FakeComment {
  id: number;
  issue: number;
  body: string;
  user: FakeUser;
  created_at: string;
  updated_at: string;
}

/**
 * In-memory GitHub for one repository (owner "xbankov"), implementing just the
 * REST endpoints the maintainer uses, with realistic auth checks.
 */
export class FakeGitHub {
  readonly owner = "xbankov";
  issues = new Map<number, FakeIssue>();
  comments: FakeComment[] = [];
  repoLabels = new Set<string>();
  /** Number of upcoming comment posts that fail with HTTP 500 (failure injection). */
  failCommentPosts = 0;
  /** Local bare repository standing in for the GitHub remote (PR head commits come from it). */
  originPath = "";
  pulls = new Map<
    number,
    {
      number: number;
      head: string;
      base: string;
      title: string;
      body: string;
      draft: boolean;
      state: "open" | "closed";
    }
  >();
  /** CI result per head commit; default: one passing check. */
  ci: (sha: string) => {
    checks: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
    statuses: Array<{ context: string; state: string }>;
  } = () => ({
    checks: [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    statuses: [],
  });
  jobLog = "line 1\nError: assertion failed in test_app.py\n";

  headSha(branch: string): string {
    return execFileSync("git", ["rev-parse", `refs/heads/${branch}`], {
      cwd: this.originPath,
      encoding: "utf8",
    }).trim();
  }

  private pullJson(n: number) {
    const p = this.pulls.get(n)!;
    return {
      number: p.number,
      node_id: `PR_${p.number}`,
      head: { ref: p.head, sha: this.headSha(p.head) },
      base: { ref: p.base },
      title: p.title,
      body: p.body,
      draft: p.draft,
      state: p.state,
      merged: false,
      html_url: `https://github.test/xbankov/repo/pull/${p.number}`,
    };
  }
  private nextNumber = 1;
  private nextCommentId = 1000;
  private clock = Date.parse("2026-01-01T00:00:00Z");
  readonly http = mockFetch((req) => this.handle(req));

  /** Monotonic fake timestamps so ordering is deterministic. */
  tick(): string {
    this.clock = Math.max(this.clock + 1000, Date.now());
    return new Date(this.clock).toISOString();
  }

  addIssue(opts: {
    title: string;
    body?: string;
    by?: FakeUser;
    labeledBy?: FakeUser;
    label?: string;
    pullRequest?: boolean;
  }): number {
    const number = this.nextNumber++;
    const now = this.tick();
    const issue: FakeIssue = {
      number,
      title: opts.title,
      body: opts.body ?? `Body of ${opts.title}`,
      state: "open",
      labels: [],
      user: opts.by ?? USERS.xbankov,
      created_at: now,
      updated_at: now,
      events: [],
      ...(opts.pullRequest ? { pull_request: {} } : {}),
    };
    this.issues.set(number, issue);
    if (opts.labeledBy) this.label(number, opts.label ?? "ai:allowed", opts.labeledBy);
    return number;
  }

  label(number: number, name: string, actor: FakeUser): void {
    const issue = this.issues.get(number)!;
    if (!issue.labels.includes(name)) issue.labels.push(name);
    issue.events.push({ event: "labeled", label: { name }, actor, created_at: this.tick() });
    issue.updated_at = this.tick();
  }

  unlabel(number: number, name: string, actor: FakeUser = USERS.xbankov): void {
    const issue = this.issues.get(number)!;
    issue.labels = issue.labels.filter((l) => l !== name);
    issue.events.push({ event: "unlabeled", label: { name }, actor, created_at: this.tick() });
    issue.updated_at = this.tick();
  }

  edit(number: number, patch: { title?: string; body?: string; state?: "open" | "closed" }): void {
    Object.assign(this.issues.get(number)!, patch, { updated_at: this.tick() });
  }

  comment(issue: number, user: FakeUser, body: string): number {
    const now = this.tick();
    const id = this.nextCommentId++;
    this.comments.push({ id, issue, body, user, created_at: now, updated_at: now });
    this.issues.get(issue)!.updated_at = now;
    return id;
  }

  commentsOn(issue: number): FakeComment[] {
    return this.comments.filter((c) => c.issue === issue);
  }

  botComments(issue: number): string[] {
    return this.commentsOn(issue)
      .filter((c) => c.user.type === "Bot")
      .map((c) => c.body);
  }

  labelsOf(issue: number): string[] {
    return [...this.issues.get(issue)!.labels].sort();
  }

  private issueJson(i: FakeIssue) {
    const { events: _events, ...rest } = i;
    return { ...rest, labels: i.labels.map((name) => ({ name })) };
  }

  private commentJson(c: FakeComment) {
    return {
      id: c.id,
      body: c.body,
      user: c.user,
      created_at: c.created_at,
      updated_at: c.updated_at,
      issue_url: `https://api.github.test/repos/${this.owner}/repo/issues/${c.issue}`,
    };
  }

  private handle({
    method,
    url,
    headers,
    body,
  }: {
    method: string;
    url: URL;
    headers: Headers;
    body: unknown;
  }) {
    const auth = headers.get("authorization") ?? "";
    const isJwt = auth.startsWith("bearer ey");
    const isInstallation = auth.startsWith("token ghs_");
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    if (method === "GET" && path === "/app" && isJwt) {
      return {
        body: {
          id: 123,
          slug: "maint",
          permissions: {
            contents: "write",
            issues: "write",
            pull_requests: "write",
            metadata: "read",
            actions: "read",
            checks: "read",
            statuses: "read",
          },
        },
      };
    }
    if (method === "GET" && path === "/users/maint[bot]") return { body: USERS.bot };
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (method === "GET" && user) {
      const found = Object.values(USERS).find(
        (u) => u.login.toLowerCase() === user[1]!.toLowerCase(),
      );
      return found ? { body: found } : { status: 404, body: { message: "Not Found" } };
    }
    if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(path) && isJwt) {
      return {
        body: {
          id: 55,
          permissions: {
            contents: "write",
            issues: "write",
            pull_requests: "write",
            metadata: "read",
            actions: "read",
            checks: "read",
            statuses: "read",
          },
        },
      };
    }
    if (method === "POST" && path === "/app/installations/55/access_tokens" && isJwt) {
      return { status: 201, body: { token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" } };
    }
    if (!isInstallation) return { status: 401, body: { message: "Bad credentials" } };
    if (method === "POST" && path === "/graphql") {
      const id = (body as { variables?: { id?: string } }).variables?.id ?? "";
      const pr = this.pulls.get(Number(id.replace("PR_", "")));
      if (pr) pr.draft = false;
      return { body: { data: { markPullRequestReadyForReview: { clientMutationId: null } } } };
    }

    const m = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(path);
    if (!m) return undefined;
    const sub = m[1] ?? "";

    if (method === "POST" && sub === "/pulls") {
      const b = body as { head: string; base: string; title: string; body: string; draft: boolean };
      const number = this.nextNumber++;
      this.pulls.set(number, { number, ...b, draft: Boolean(b.draft), state: "open" });
      const now = this.tick();
      this.issues.set(number, {
        number,
        title: b.title,
        body: b.body,
        state: "open",
        labels: [],
        user: USERS.bot,
        created_at: now,
        updated_at: now,
        events: [],
        pull_request: {},
      });
      return { status: 201, body: this.pullJson(number) };
    }
    if (method === "GET" && sub === "/pulls") {
      const head = q.get("head")?.split(":")[1];
      return {
        body: [...this.pulls.values()]
          .filter((p) => p.state === (q.get("state") ?? "open") && (!head || p.head === head))
          .map((p) => this.pullJson(p.number)),
      };
    }
    const pull = /^\/pulls\/(\d+)$/.exec(sub);
    if (pull && this.pulls.has(Number(pull[1]))) {
      const p = this.pulls.get(Number(pull[1]))!;
      if (method === "PATCH") Object.assign(p, body as object);
      return { body: this.pullJson(p.number) };
    }
    const ci = /^\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(sub);
    if (method === "GET" && ci) {
      const r = this.ci(ci[1]!);
      return ci[2] === "check-runs"
        ? {
            body: {
              total_count: r.checks.length,
              check_runs: r.checks.map((c) => ({ ...c, app: { slug: "github-actions" } })),
            },
          }
        : { body: { state: "success", statuses: r.statuses } };
    }
    if (method === "GET" && /^\/actions\/jobs\/\d+\/logs$/.test(sub)) {
      return { body: this.jobLog, headers: { "content-type": "text/plain" } };
    }
    if (method === "GET" && sub === "/labels")
      return { body: [...this.repoLabels].map((name) => ({ name })) };
    if (method === "POST" && sub === "/labels") {
      this.repoLabels.add((body as { name: string }).name);
      return { status: 201, body };
    }
    if (method === "GET" && sub === "/issues") {
      const label = q.get("labels");
      const list = [...this.issues.values()]
        .filter(
          (i) => (q.get("state") ?? "open") === "all" || i.state === (q.get("state") ?? "open"),
        )
        .filter((i) => !label || i.labels.includes(label))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { body: list.map((i) => this.issueJson(i)) };
    }
    if (method === "GET" && sub === "/issues/comments") {
      const since = q.get("since") ?? "1970-01-01T00:00:00Z";
      return {
        body: this.comments.filter((c) => c.updated_at >= since).map((c) => this.commentJson(c)),
      };
    }
    const issueRoute = /^\/issues\/(\d+)(\/.*)?$/.exec(sub);
    if (issueRoute) {
      const issue = this.issues.get(Number(issueRoute[1]));
      if (!issue) return { status: 404, body: { message: "Not Found" } };
      const rest = issueRoute[2] ?? "";
      if (method === "GET" && rest === "") return { body: this.issueJson(issue) };
      if (method === "GET" && rest === "/events") return { body: issue.events };
      if (method === "GET" && rest === "/comments") {
        return { body: this.commentsOn(issue.number).map((c) => this.commentJson(c)) };
      }
      if (method === "POST" && rest === "/comments") {
        if (this.failCommentPosts > 0) {
          this.failCommentPosts--;
          return { status: 500, body: { message: "Server Error" } };
        }
        const id = this.comment(issue.number, USERS.bot, (body as { body: string }).body);
        const created = this.comments.find((c) => c.id === id)!;
        return { status: 201, body: { id, created_at: created.created_at } };
      }
      if (method === "POST" && rest === "/labels") {
        for (const name of (body as { labels: string[] }).labels)
          this.label(issue.number, name, USERS.bot);
        return { body: issue.labels.map((name) => ({ name })) };
      }
      const del = /^\/labels\/(.+)$/.exec(rest);
      if (method === "DELETE" && del) {
        if (!issue.labels.includes(del[1]!))
          return { status: 404, body: { message: "Label does not exist" } };
        this.unlabel(issue.number, del[1]!, USERS.bot);
        return { body: [] };
      }
    }
    return undefined;
  }
}
