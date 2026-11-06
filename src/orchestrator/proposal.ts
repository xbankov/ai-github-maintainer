import { createHash } from "node:crypto";
import { z } from "zod";

/** Structured analysis result (SPEC §2.2). Extra keys from the model are dropped. */
export const proposalSchema = z
  .object({
    valid: z.boolean().describe("Does the issue make sense and is it actionable?"),
    summary: z.string().min(1).max(600).describe("One or two sentences"),
    reasoning: z
      .string()
      .min(1)
      .max(5000)
      .describe(
        "Why the issue is (in)valid: actionable? already implemented? duplicate? consistent with the architecture? likely cause?",
      ),
    implementation: z
      .array(z.string().min(1).max(1000))
      .max(30)
      .describe("Ordered implementation steps; empty if not actionable"),
    affected_files: z.array(z.string().min(1).max(300)).max(60),
    risks: z.array(z.string().min(1).max(1000)).max(20),
    tests: z
      .array(z.string().min(1).max(1000))
      .max(20)
      .default([])
      .describe("Tests needed to verify the change"),
    estimated_complexity: z.enum(["small", "medium", "large"]),
    questions: z
      .array(z.string().min(1).max(1000))
      .max(20)
      .describe("Missing information that must be clarified before implementing"),
  })
  .superRefine((p, ctx) => {
    if (p.valid && p.questions.length === 0 && p.implementation.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["implementation"],
        message: "a valid issue without open questions needs implementation steps",
      });
    }
  });
export type Proposal = z.infer<typeof proposalSchema>;

/**
 * A proposal can be approved when the issue is valid and there is a plan.
 * Open questions do not block approval: approving accepts the plan as written.
 */
export function isImplementable(p: Proposal): boolean {
  return p.valid && p.implementation.length > 0;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Detects changed issues: title + body (labels and comments are not part of it). */
export function issueFingerprint(issue: { title: string; body: string }): string {
  return sha256(`${issue.title.trim()}\n${issue.body.replace(/\r\n/g, "\n").trim()}`);
}

/** Stable hash of the proposal content, used to avoid publishing duplicates. */
export function proposalFingerprint(p: Proposal): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return sha256(JSON.stringify(canonical(p)));
}

/** Extracts and validates the JSON object from a model reply. */
export function parseProposal(
  text: string,
): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "no JSON object found" };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = proposalSchema.safeParse(raw);
  return result.success
    ? { ok: true, proposal: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

// ---------------------------------------------------------------------------
// Rendering

export const PROPOSAL_MARKER = /<!--\s*ai-maintainer:proposal task=(\d+) version=(\d+)\s*-->/;

/**
 * Makes model-written text safe to embed in a GitHub comment: no mentions
 * (no surprise notifications), no HTML comments (cannot fake our markers),
 * no raw HTML.
 */
export function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/</g, "&lt;")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@​")
    .trim();
}

const list = (items: string[], ordered = false) =>
  items.map((s, i) => `${ordered ? `${i + 1}.` : "-"} ${sanitize(s)}`).join("\n");

export function renderProposalComment(input: {
  taskId: number;
  version: number;
  proposal: Proposal;
  note?: string;
}): string {
  const p = input.proposal;
  const implementable = isImplementable(p);
  const parts = [
    `<!-- ai-maintainer:proposal task=${input.taskId} version=${input.version} -->`,
    `### 🤖 AI proposal v${input.version}`,
    input.note ? `> ${sanitize(input.note)}\n` : "",
    `**Summary:** ${sanitize(p.summary)}`,
    `**Assessment:** ${
      implementable
        ? p.questions.length
          ? "✅ actionable (see open questions)"
          : "✅ actionable"
        : p.valid
          ? "❓ needs clarification"
          : "⛔ not actionable"
    } · **Complexity:** ${p.estimated_complexity}`,
    `#### Reasoning\n${sanitize(p.reasoning)}`,
  ];
  if (p.implementation.length)
    parts.push(`#### Implementation plan\n${list(p.implementation, true)}`);
  if (p.affected_files.length) {
    parts.push(
      `#### Affected files\n${p.affected_files.map((f) => `- \`${f.replace(/`/g, "")}\``).join("\n")}`,
    );
  }
  if (p.tests.length) parts.push(`#### Tests\n${list(p.tests)}`);
  if (p.risks.length) parts.push(`#### Risks\n${list(p.risks)}`);
  if (p.questions.length) parts.push(`#### Open questions\n${list(p.questions)}`);
  parts.push(
    "---",
    implementable
      ? p.questions.length
        ? "Maintainers: `/ai approve` implements this plan as written; to settle an open question first, reply `/ai revise <answer>`. `/ai reject` declines."
        : "Maintainers: reply `/ai approve` to implement this version, `/ai reject` to decline, or `/ai revise <what to change>`."
      : "Maintainers: answer the questions in the issue (editing the issue triggers a new analysis) or reply `/ai revise <guidance>`; `/ai reject` declines.",
  );
  return parts.filter(Boolean).join("\n\n");
}
