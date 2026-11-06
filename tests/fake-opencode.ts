import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApprovedPlan, Proposal } from "../src/orchestrator/proposal.js";
import { mockFetch } from "./helpers.js";

export function defaultProposal(issueTitle: string, extra: Partial<Proposal> = {}): Proposal {
  return {
    valid: true,
    summary: `Fix: ${issueTitle}`,
    reasoning: "The bug is reproducible from the code.",
    implementation: [`Change the code for "${issueTitle}"`, "Add a regression test"],
    affected_files: ["src/app.py"],
    risks: ["Low"],
    tests: ["Unit test for the fix"],
    estimated_complexity: "small",
    questions: [],
    ...extra,
  };
}

export function defaultPlan(issueTitle: string, extra: Partial<ApprovedPlan> = {}): ApprovedPlan {
  return {
    ...defaultProposal(issueTitle),
    differences_from_issue: ["Also covers the import path"],
    ...extra,
  };
}

interface FakeMessage {
  id: string;
  type: "user" | "assistant";
  time: { created: number };
  text?: string;
  metadata?: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
}

export interface FakeSession {
  id: string;
  title: string;
  directory: string;
  agent: string;
  permissions: unknown[];
  messages: FakeMessage[];
  busy: boolean;
  questions: number;
  interrupted: number;
}

/**
 * Fake OpenCode 2.2 server with stateful sessions. By default the agent
 * answers every prompt immediately (not busy afterwards). The build agent
 * edits a file in the session directory, like a real implementation would.
 */
export class FakeOpenCode {
  sessions = new Map<string, FakeSession>();
  /** JSON returned by `generate` (the approved plan). */
  plan: (session: FakeSession, attempt: number) => string = (s) =>
    JSON.stringify(defaultPlan(/#\d+ — (.*)/.exec(s.title)?.[1] ?? "x"));
  /** Whether the build agent changes files when prompted. */
  editsFiles = true;
  /** Approval check: does this text approve? Default: a clear go-ahead without a question. */
  approves: (messages: string[]) => boolean = (messages) =>
    messages.some(
      (m) => /\b(implement it|go ahead|approved?|ship it)\b/i.test(m) && !m.includes("?"),
    );
  /** Review scope check result. */
  withinScope = true;
  /** Feature ideas returned by feature discovery. */
  features: Array<{ title: string }> = [];
  /** Extra files the build agent writes (path relative to the worktree → content). */
  extraFiles: Record<string, string> = {};
  private nextId = 1;
  private nextMsg = 1;
  private clock = Date.now();
  private generateCalls = new Map<string, number>();

  now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  /** A maintainer types a message in the OpenCode UI. */
  say(sessionId: string, text: string, opts: { busy?: boolean } = {}): string {
    const s = this.sessions.get(sessionId)!;
    const id = `msg_${this.nextMsg++}`;
    s.messages.push({ id, type: "user", time: { created: this.now() }, text });
    s.busy = opts.busy ?? false;
    if (!opts.busy) this.reply(s, `Answer to: ${text}`);
    return id;
  }

  /** Moves the whole session history into the past (for inactivity timers). */
  age(sessionId: string, ms: number): void {
    for (const m of this.sessions.get(sessionId)!.messages) m.time.created -= ms;
  }

  only(): FakeSession {
    const [s] = [...this.sessions.values()];
    return s!;
  }

  private reply(s: FakeSession, text: string) {
    s.messages.push({
      id: `msg_${this.nextMsg++}`,
      type: "assistant",
      time: { created: this.now() },
      content: [{ type: "text", text }],
    });
  }

  readonly http = mockFetch(({ method, url, body }) => {
    const p = url.pathname;
    if (method === "GET" && p === "/api/info") return { body: { version: "2.2.5" } };
    if (method === "GET" && p === "/api/agent") {
      return {
        body: { location: {}, data: [{ id: "maintainer-plan" }, { id: "maintainer-build" }] },
      };
    }
    if (method === "GET" && p === "/api/session/active") {
      return {
        body: {
          data: Object.fromEntries(
            [...this.sessions.values()]
              .filter((s) => s.busy)
              .map((s) => [s.id, { type: "running" }]),
          ),
        },
      };
    }
    if (method === "POST" && p === "/api/session") {
      const b = body as {
        agent: string;
        title: string;
        location: { directory: string };
        permissions: unknown[];
      };
      const id = `ses_${this.nextId++}`;
      this.sessions.set(id, {
        id,
        title: b.title,
        directory: b.location.directory,
        agent: b.agent,
        permissions: b.permissions,
        messages: [],
        busy: false,
        questions: 0,
        interrupted: 0,
      });
      return { body: { data: { id } } };
    }
    const m = /^\/api(?:\/experimental)?\/session\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return undefined;
    const s = this.sessions.get(m[1]!);
    if (!s) return { status: 404, body: { message: "Session not found" } };
    switch (`${method} ${m[2] ?? ""}`) {
      case "DELETE ":
        this.sessions.delete(s.id);
        return { status: 204 };
      case "PATCH ":
        s.permissions = (body as { permissions?: unknown[] }).permissions ?? s.permissions;
        s.title = (body as { title?: string }).title ?? s.title;
        return { status: 204 };
      case "POST /agent":
        s.agent = (body as { agent: string }).agent;
        return { status: 204 };
      case "POST /interrupt":
        s.busy = false;
        s.interrupted++;
        return { body: { data: {} } };
      case "GET /form":
        return {
          body: { data: Array.from({ length: s.questions }, (_, i) => ({ id: `form_${i}` })) },
        };
      case "POST /prompt": {
        const b = body as { text: string; metadata?: Record<string, unknown> };
        s.messages.push({
          id: `msg_${this.nextMsg++}`,
          type: "user",
          time: { created: this.now() },
          text: b.text,
          metadata: b.metadata,
        });
        if (
          s.agent === "maintainer-build" &&
          this.editsFiles &&
          !b.text.startsWith("[maintainer service]")
        ) {
          writeFileSync(
            join(s.directory, `change-${this.nextMsg}.txt`),
            `${b.text.slice(0, 40)}\n`,
          );
          for (const [file, content] of Object.entries(this.extraFiles)) {
            mkdirSync(dirname(join(s.directory, file)), { recursive: true });
            writeFileSync(join(s.directory, file), content);
          }
          this.reply(s, "Changed change-N.txt; test with the existing suite.");
        } else {
          this.reply(s, "I looked at the code. Proposed plan: …");
        }
        return { body: { data: { id: "msg", type: "user" } } };
      }
      case "POST /wait":
        s.busy = false;
        return { status: 204 };
      case "GET /context":
        return { body: { data: s.messages } };
      case "POST /generate": {
        const prompt = (body as { prompt: string }).prompt;
        if (prompt.includes("clearly and explicitly approve")) {
          const quoted = prompt
            .split("\n")
            .filter((l) => l.startsWith("> "))
            .map((l) => l.slice(2));
          return {
            body: {
              data: { text: JSON.stringify({ approved: this.approves(quoted), reason: "" }) },
            },
          };
        }
        if (prompt.includes("stay within the approved plan")) {
          return {
            body: {
              data: {
                text: JSON.stringify({
                  within_scope: this.withinScope,
                  reason: "needs a new page",
                }),
              },
            },
          };
        }
        if (prompt.includes("output your best ideas")) {
          const features = this.features.map((f) => ({
            problem: "p",
            why: "w",
            implementation: "i",
            benefit: "b",
            complexity: "small",
            risks: [],
            ...f,
          }));
          return { body: { data: { text: JSON.stringify({ features }) } } };
        }
        const n = (this.generateCalls.get(s.id) ?? 0) + 1;
        this.generateCalls.set(s.id, n);
        return { body: { data: { text: this.plan(s, n) } } };
      }
      default:
        return undefined;
    }
  });
}
