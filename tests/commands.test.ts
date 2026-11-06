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
