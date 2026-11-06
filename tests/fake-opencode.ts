import type { Proposal } from "../src/orchestrator/proposal.js";
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

/**
 * Fake OpenCode 2.2 server. Each session remembers its analysis prompt; the
 * JSON answer is produced by `answer(prompt)` (default: a valid proposal for
 * the issue title found in the prompt).
 */
export class FakeOpenCode {
  sessions = new Map<string, { directory: string; agent: string; prompts: string[] }>();
  deleted: string[] = [];
  answer: (analysisPrompt: string, attempt: number) => string = (prompt) =>
    JSON.stringify(defaultProposal(/#\d+: (.*)/.exec(prompt)?.[1] ?? "unknown"));
  private nextId = 1;
  private generateCalls = new Map<string, number>();

  readonly http = mockFetch(({ method, url, body }) => {
    const p = url.pathname;
    if (method === "GET" && p === "/api/info") return { body: { version: "2.2.5" } };
    if (method === "GET" && p === "/api/agent") {
      return {
        body: { location: {}, data: [{ id: "maintainer-plan" }, { id: "maintainer-build" }] },
      };
    }
    if (method === "POST" && p === "/api/session") {
      const b = body as { agent: string; location: { directory: string } };
      const id = `ses_${this.nextId++}`;
      this.sessions.set(id, { directory: b.location.directory, agent: b.agent, prompts: [] });
      return { body: { data: { id } } };
    }
    const m = /^\/api(?:\/experimental)?\/session\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return undefined;
    const session = this.sessions.get(m[1]!);
    if (!session) return { status: 404, body: { message: "Session not found" } };
    switch (`${method} ${m[2] ?? ""}`) {
      case "DELETE ":
        this.deleted.push(m[1]!);
        return { status: 204 };
      case "POST /prompt":
        session.prompts.push((body as { text: string }).text);
        return { body: { data: { id: "msg", type: "user" } } };
      case "POST /wait":
        return { status: 204 };
      case "GET /context":
        return {
          body: {
            data: [
              {
                id: "a1",
                type: "assistant",
                time: { created: 1 },
                agent: session.agent,
                model: { id: "m", providerID: "p" },
                content: [{ type: "text", text: "I reviewed the code." }],
              },
            ],
          },
        };
      case "POST /generate": {
        const n = (this.generateCalls.get(m[1]!) ?? 0) + 1;
        this.generateCalls.set(m[1]!, n);
        return { body: { data: { text: this.answer(session.prompts[0] ?? "", n) } } };
      }
      default:
        return undefined;
    }
  });
}
