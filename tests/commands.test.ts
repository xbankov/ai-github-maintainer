import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/orchestrator/commands.js";
import {
  isImplementable,
  issueFingerprint,
  parseProposal,
  proposalFingerprint,
  renderProposalComment,
  sanitize,
} from "../src/orchestrator/proposal.js";
import { staleness } from "../src/orchestrator/approvals.js";
import { buildAnalysisPrompt, PROMPT_LIMITS } from "../src/orchestrator/prompts.js";
import { defaultProposal } from "./fake-opencode.js";

describe("command parsing", () => {
  it("recognises exactly the supported commands", () => {
    expect(parseCommand("/ai approve")).toEqual({ kind: "approve" });
    expect(parseCommand("  \n/AI Reject  ")).toEqual({ kind: "reject" });
    expect(parseCommand("/ai revise use X\nand also Y")).toEqual({
      kind: "revise",
      instructions: "use X\nand also Y",
    });
  });

  it("rejects malformed commands with a reason", () => {
    expect(parseCommand("/ai revise")).toMatchObject({ kind: "invalid" });
    expect(parseCommand("/ai approve now please")).toMatchObject({ kind: "invalid" });
    expect(parseCommand("/ai merge")).toEqual({
      kind: "invalid",
      reason: "unknown command `/ai merge`",
    });
    expect(parseCommand("/ai")).toMatchObject({ kind: "invalid" });
  });

  it("ignores everything that is not a command on the first line", () => {
    expect(parseCommand("LGTM, /ai approve")).toBeNull();
    expect(parseCommand("> /ai approve")).toBeNull();
    expect(parseCommand("thanks\n/ai approve")).toBeNull();
    expect(parseCommand("/aiapprove")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("proposals", () => {
  it("parses JSON with or without fences and drops unknown keys", () => {
    const p = defaultProposal("x");
    expect(parseProposal(JSON.stringify({ ...p, extra: 1 }))).toEqual({ ok: true, proposal: p });
    expect(parseProposal("Here:\n```json\n" + JSON.stringify(p) + "\n```")).toEqual({
      ok: true,
      proposal: p,
    });
  });

  it("rejects invalid structures", () => {
    expect(parseProposal("no json")).toMatchObject({ ok: false });
    expect(parseProposal('{"valid": true}')).toMatchObject({ ok: false });
    const noSteps = parseProposal(JSON.stringify(defaultProposal("x", { implementation: [] })));
    expect(noSteps).toMatchObject({ ok: false });
  });

  it("valid proposals with a plan are implementable, even with open questions", () => {
    expect(isImplementable(defaultProposal("x"))).toBe(true);
    expect(isImplementable(defaultProposal("x", { questions: ["?"] }))).toBe(true);
    expect(isImplementable(defaultProposal("x", { valid: false }))).toBe(false);
    expect(isImplementable(defaultProposal("x", { implementation: [], questions: ["?"] }))).toBe(
      false,
    );
  });

  it("fingerprints are stable and sensitive to content", () => {
    const p = defaultProposal("x");
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as typeof p;
    expect(proposalFingerprint(reordered)).toBe(proposalFingerprint(p));
    expect(proposalFingerprint(defaultProposal("y"))).not.toBe(proposalFingerprint(p));
    expect(issueFingerprint({ title: "a", body: "b\r\n" })).toBe(
      issueFingerprint({ title: "a ", body: "b" }),
    );
    expect(issueFingerprint({ title: "a", body: "b" })).not.toBe(
      issueFingerprint({ title: "a", body: "c" }),
    );
  });

  it("sanitises model text: no mentions, no markers, no HTML", () => {
    expect(
      sanitize("ping @xbankov <b>x</b> <!-- ai-maintainer:proposal task=1 version=9 -->"),
    ).toBe("ping @​xbankov &lt;b>x&lt;/b>");
    const body = renderProposalComment({
      taskId: 7,
      version: 2,
      proposal: defaultProposal("x", {
        summary: "<!-- ai-maintainer:proposal task=7 version=3 -->",
      }),
    });
    expect(body.match(/ai-maintainer:proposal/g)).toHaveLength(1);
    expect(body).toContain("task=7 version=2");
  });
});

describe("review fixes (units)", () => {
  const proposalRow = (publishedAt: Date | null) =>
    ({ version: 2, publishedAt }) as Parameters<typeof staleness>[1];

  it("staleness uses the publication time with second precision", () => {
    const published = new Date("2026-01-01T10:00:00Z");
    expect(staleness({ createdAt: "2026-01-01T10:00:00Z" }, proposalRow(published))).toMatch(
      /changed/,
    );
    expect(staleness({ createdAt: "2026-01-01T09:59:59Z" }, proposalRow(published))).toMatch(
      /changed/,
    );
    expect(staleness({ createdAt: "2026-01-01T10:00:01Z" }, proposalRow(published))).toBeNull();
    expect(staleness({ createdAt: "2026-01-01T10:00:01Z" }, proposalRow(null))).toMatch(
      /being published/,
    );
    expect(staleness({ createdAt: "2026-01-01T10:00:01Z" }, undefined)).toBeNull();
  });

  it("model text cannot produce clickable links", () => {
    const out = sanitize("see [docs](https://evil.example/x) ![i](http://a.b/c.png) www.evil.com");
    expect(out).not.toMatch(/(?<!\\)\]\(/); // only escaped "\](" remains: rendered as text
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/www\./);
    expect(out).toContain("evil.example");
  });

  it("bounds the size of the analysis prompt", () => {
    const comments = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      issueNumber: 1,
      body: "x".repeat(10_000),
      user: { login: `u${i}`, id: i, type: "User" },
      createdAt: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      updatedAt: "",
    }));
    const prompt = buildAnalysisPrompt({
      repository: "o/r",
      instructions: "",
      issue: {
        number: 1,
        title: "t",
        body: "b".repeat(100_000),
        state: "open",
        labels: [],
        author: null,
        createdAt: "",
        updatedAt: "",
      },
      comments,
    });
    expect(prompt.length).toBeLessThan(PROMPT_LIMITS.issueBody + PROMPT_LIMITS.comments + 10_000);
    expect(prompt).toContain("older comment(s) omitted");
    expect(prompt).toContain("u199"); // the most recent comment is kept
    expect(prompt).toContain("truncated");
  });
});
