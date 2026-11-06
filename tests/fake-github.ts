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
    if (opts.labeledBy) this.label(number, opts.label ?? "ai-allowed", opts.labeledBy);
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
    if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(path) && isJwt) return { body: { id: 55 } };
    if (method === "POST" && path === "/app/installations/55/access_tokens" && isJwt) {
      return { status: 201, body: { token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" } };
    }
    if (!isInstallation) return { status: 401, body: { message: "Bad credentials" } };

    const m = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(path);
    if (!m) return undefined;
    const sub = m[1] ?? "";

    if (method === "GET" && sub === "/labels")
      return { body: [...this.repoLabels].map((name) => ({ name })) };
    if (method === "POST" && sub === "/labels") {
      this.repoLabels.add((body as { name: string }).name);
      return { status: 201, body };
    }
    if (method === "GET" && sub === "/issues") {
      const label = q.get("labels");
      const list = [...this.issues.values()]
        .filter((i) => i.state === (q.get("state") ?? "open"))
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
        const id = this.comment(issue.number, USERS.bot, (body as { body: string }).body);
        return { status: 201, body: { id } };
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
