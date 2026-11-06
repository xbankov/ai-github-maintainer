import { createHash } from "node:crypto";
import { z } from "zod";

/** Structured analysis result (SPEC §2.2). Extra keys from the model are dropped. */
const proposalFields = {
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
};

const requirePlan = (
  p: { valid: boolean; questions: string[]; implementation: string[] },
  ctx: z.RefinementCtx,
) => {
  if (p.valid && p.questions.length === 0 && p.implementation.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["implementation"],
      message: "a valid issue without open questions needs implementation steps",
    });
  }
};

/** Structured analysis result (SPEC §2.2). Extra keys from the model are dropped. */
export const proposalSchema = z.object(proposalFields).superRefine(requirePlan);
export type Proposal = z.infer<typeof proposalSchema>;

/** Result of the approval check on the maintainer's messages. */
export const approvalCheckSchema = z.object({
  approved: z.boolean(),
  reason: z.string().max(500).default(""),
});

/** Result of the review scope check. */
export const scopeCheckSchema = z.object({
  within_scope: z.boolean(),
  reason: z.string().min(1).max(1000),
});

/** Feature proposals from feature discovery (SPEC §2.6). */
export const featureSchema = z.object({
  title: z.string().min(5).max(120),
  problem: z.string().min(1).max(2000).describe("Problem or opportunity"),
  why: z.string().min(1).max(2000).describe("Why it matters"),
  implementation: z.string().min(1).max(3000).describe("Suggested implementation"),
  benefit: z.string().min(1).max(1000).describe("Expected benefit"),
  complexity: z.enum(["small", "medium", "large"]),
  risks: z.array(z.string().min(1).max(500)).max(10),
});
export type Feature = z.infer<typeof featureSchema>;
export const featureListSchema = z.object({ features: z.array(featureSchema).max(10) });

/**
 * Normalised title fingerprint: the same idea with different casing, accents,
 * punctuation or word order maps to the same value; every other word counts.
 */
export function featureFingerprint(title: string): string {
  const stop = new Set(["a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with"]);
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !stop.has(w));
  return createHash("sha256")
    .update([...new Set(words)].sort().join(" "))
    .digest("hex");
}

export function renderFeatureIssue(f: Feature): string {
  return [
    `**Problem or opportunity**\n${sanitize(f.problem)}`,
    `**Why it matters**\n${sanitize(f.why)}`,
    `**Suggested implementation**\n${sanitize(f.implementation)}`,
    `**Expected benefit**\n${sanitize(f.benefit)}`,
    `**Complexity:** ${f.complexity}`,
    f.risks.length ? `**Risks**\n${list(f.risks)}` : "",
    "---",
    "🤖 Suggested by the AI maintainer. Nothing happens unless a maintainer adds `ai:allowed`.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The plan the maintainer approved in the OpenCode session. */
export const approvedPlanSchema = z
  .object({
    ...proposalFields,
    differences_from_issue: z
      .array(z.string().min(1).max(1000))
      .max(20)
      .default([])
      .describe("How the approved plan differs from the original issue description"),
  })
  .superRefine(requirePlan);
export type ApprovedPlan = z.infer<typeof approvedPlanSchema>;

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
  const r = parseStructured(text, proposalSchema);
  return r.ok ? { ok: true, proposal: r.value } : r;
}

/** Extracts and validates one JSON object from a model reply. */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
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
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

// ---------------------------------------------------------------------------
// Rendering

export const PROPOSAL_MARKER = /<!--\s*ai-maintainer:proposal task=(\d+) version=(\d+)\s*-->/;

/**
 * Makes model-written text safe to embed in a GitHub comment: no mentions
 * (no surprise notifications), no HTML comments (cannot fake our markers),
 * no raw HTML, and no clickable links (an issue author could otherwise make
 * the bot post a phishing link): Markdown link/image syntax is escaped and
 * bare URLs are defanged.
 */
export function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/</g, "&lt;")
    .replace(/[[\]]/g, (c) => `\\${c}`)
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u200b")
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

/** GitHub record of what the maintainer approved in OpenCode. */
export function renderApprovedPlanComment(input: {
  taskId: number;
  version: number;
  plan: ApprovedPlan;
  approvedBy: string;
}): string {
  const p = input.plan;
  const parts = [
    `<!-- ai-maintainer:proposal task=${input.taskId} version=${input.version} -->`,
    `### ✅ Approved implementation plan v${input.version}`,
    `Approved by @${input.approvedBy} in the OpenCode session · **Complexity:** ${p.estimated_complexity}`,
    `**Summary:** ${sanitize(p.summary)}`,
    `#### Differences from the issue description\n${
      p.differences_from_issue.length
        ? list(p.differences_from_issue)
        : "None — the plan follows the issue."
    }`,
    `#### Plan\n${list(p.implementation, true)}`,
  ];
  if (p.affected_files.length) {
    parts.push(
      `#### Affected files\n${p.affected_files.map((f) => `- \`${f.replace(/`/g, "")}\``).join("\n")}`,
    );
  }
  if (p.tests.length) parts.push(`#### Tests\n${list(p.tests)}`);
  if (p.risks.length) parts.push(`#### Risks\n${list(p.risks)}`);
  parts.push(
    "---",
    "🤖 The bot now implements this plan and opens a pull request. It never merges.",
  );
  return parts.join("\n\n");
}
