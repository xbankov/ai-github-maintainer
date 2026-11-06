import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { IssueComment, IssueSummary } from "../github/issues.js";
import { approvedPlanSchema, type Proposal } from "./proposal.js";

/** prompts/ lives at the project root, next to src/ and dist/. */
const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

const cache = new Map<string, string>();
function template(name: string): string {
  let text = cache.get(name);
  if (!text) {
    text = readFileSync(`${PROMPTS_DIR}${name}`, "utf8");
    cache.set(name, text);
  }
  return text;
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

/** Removes anything that could close or fake an untrusted block. */
function neutralise(text: string): string {
  return text.replace(/<\/?\s*untrusted[^>]*>/gi, "[removed tag]");
}

/** Size limits keep long discussions within the model's context. */
export const PROMPT_LIMITS = { issueBody: 20_000, comment: 4_000, comments: 24_000 };

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[… truncated ${text.length - max} characters]`;
}

/** Most recent comments first in priority, each clipped, within the total budget; shown oldest first. */
function boundedComments(comments: IssueComment[]): string {
  const picked: string[] = [];
  let used = 0;
  for (const c of [...comments].reverse()) {
    const entry = `--- ${c.user?.login ?? "unknown"} (${c.createdAt}):\n${clip(c.body, PROMPT_LIMITS.comment)}`;
    if (used + entry.length > PROMPT_LIMITS.comments) break;
    picked.unshift(entry);
    used += entry.length;
  }
  const omitted = comments.length - picked.length;
  return [
    ...(omitted > 0 ? [`[${omitted} older comment(s) omitted for length]`] : []),
    ...picked,
  ].join("\n\n");
}

/** First message of an issue's OpenCode session. */
export function buildConversationPrompt(input: {
  repository: string;
  instructions: string;
  issue: IssueSummary;
  comments: IssueComment[];
}): string {
  const nonce = randomBytes(6).toString("hex");
  const issue = [
    `#${input.issue.number}: ${input.issue.title}`,
    `Opened by ${input.issue.author?.login ?? "unknown"} on ${input.issue.createdAt}`,
    `Labels: ${input.issue.labels.join(", ") || "none"}`,
    "",
    clip(input.issue.body || "(no description)", PROMPT_LIMITS.issueBody),
  ].join("\n");
  const comments = input.comments.length ? boundedComments(input.comments) : "(no comments)";
  return fill(template("conversation.md"), {
    repository: input.repository,
    instructions: input.instructions.trim() || "(none)",
    issue: neutralise(issue),
    comments: neutralise(comments),
    nonce,
  });
}

/** Sent into the session when the issue text changed on GitHub. */
export function buildIssueChangedMessage(issue: IssueSummary): string {
  const nonce = randomBytes(6).toString("hex");
  return [
    "[maintainer service] The issue was edited on GitHub. Take the new text into account:",
    "",
    `<untrusted-${nonce}>`,
    neutralise(
      `#${issue.number}: ${issue.title}\n\n${clip(issue.body || "(no description)", PROMPT_LIMITS.issueBody)}`,
    ),
    `</untrusted-${nonce}>`,
  ].join("\n");
}

/**
 * Asks for the plan the maintainer just approved, as JSON, optionally with
 * feedback on a rejected attempt.
 */
export function buildApprovedPlanPrompt(previousError?: string): string {
  return [
    "The maintainer approved. Write down the plan exactly as agreed in this conversation,",
    "and list how it differs from the original issue description (empty list if it does not).",
    "Output exactly one JSON object and nothing else — no prose, no markdown fence.",
    "It must validate against this JSON Schema:",
    JSON.stringify(z.toJSONSchema(approvedPlanSchema, { io: "input" })),
    ...(previousError ? ["", "Your previous answer was rejected:", previousError, "Fix it."] : []),
  ].join("\n");
}

export function buildImplementationPrompt(input: {
  repository: string;
  branch: string;
  instructions: string;
  issue: IssueSummary;
  proposal: Proposal;
  version: number;
  approvedBy: string;
}): string {
  const issue = [
    `#${input.issue.number}: ${input.issue.title}`,
    "",
    clip(input.issue.body || "(no description)", PROMPT_LIMITS.issueBody),
  ].join("\n");
  return fill(template("implement-issue.md"), {
    repository: input.repository,
    branch: input.branch,
    instructions: input.instructions.trim() || "(none)",
    proposal: JSON.stringify(input.proposal, null, 2),
    version: String(input.version),
    approvedBy: input.approvedBy,
    issue: neutralise(issue),
    nonce: randomBytes(6).toString("hex"),
  });
}

export function buildCiFixPrompt(input: {
  round: number;
  maxRounds: number;
  failures: string[];
  logs: string;
}): string {
  return fill(template("fix-ci.md"), {
    round: String(input.round),
    maxRounds: String(input.maxRounds),
    failures: input.failures.map((f) => `- ${f}`).join("\n") || "- (unknown)",
    logs: neutralise(clip(input.logs || "(no logs available)", PROMPT_LIMITS.comments)),
    nonce: randomBytes(6).toString("hex"),
  });
}
