import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { TASK_STATES } from "../orchestrator/state-machine.js";

/** Milliseconds since epoch, filled by SQLite when the ORM does not set it. */
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
    .$onUpdate(() => new Date());

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(", ")})`);

export const TASK_TYPES = ["issue", "feature"] as const;
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;
export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;
export const DECISIONS = ["approve", "reject", "revise"] as const;

export const repositories = sqliteTable(
  "repositories",
  {
    /** Stable id from config (e.g. "songbook"). */
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastDiscoveryAt: integer("last_discovery_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("repositories_owner_name_uq").on(sql`lower(${t.owner})`, sql`lower(${t.name})`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    type: text("type", { enum: TASK_TYPES }).notNull(),
    githubIssueNumber: integer("github_issue_number").notNull(),
    githubPrNumber: integer("github_pr_number"),
    status: text("status", { enum: TASK_STATES }).notNull().default("DISCOVERED"),
    /** Latest proposal version (0 = none yet). */
    proposalVersion: integer("proposal_version").notNull().default(0),
    /** Proposal version a human approved; must equal proposalVersion to implement. */
    approvedVersion: integer("approved_version"),
    opencodeSessionId: text("opencode_session_id"),
    branchName: text("branch_name"),
    iterationCount: integer("iteration_count").notNull().default(0),
    /** Hash of the issue title/body/labels last analysed — detects changed issues. */
    issueFingerprint: text("issue_fingerprint"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // One live task per issue; finished (COMPLETED/ABANDONED) tasks may be followed by a new one.
    uniqueIndex("tasks_active_issue_uq")
      .on(t.repositoryId, t.githubIssueNumber)
      .where(sql.raw(`status not in ('COMPLETED', 'ABANDONED')`)),
    index("tasks_repository_status_idx").on(t.repositoryId, t.status),
    index("tasks_pr_idx").on(t.repositoryId, t.githubPrNumber),
    check("tasks_status_ck", inList("status", TASK_STATES)),
    check("tasks_type_ck", inList("type", TASK_TYPES)),
    check(
      "tasks_approved_version_ck",
      sql`${t.approvedVersion} is null or (${t.approvedVersion} >= 1 and ${t.approvedVersion} <= ${t.proposalVersion})`,
    ),
  ],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Validated structured analysis (JSON). */
    content: text("content", { mode: "json" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull().default("pending"),
    githubCommentId: integer("github_comment_id"),
    /** When the proposal comment appeared on GitHub (GitHub's clock). */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("proposals_task_version_uq").on(t.taskId, t.version),
    check("proposals_version_ck", sql`${t.version} >= 1`),
    check("proposals_status_ck", inList("status", PROPOSAL_STATUSES)),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    lockedBy: text("locked_by"),
    /** Idempotency key: at most one pending/running job per key (NULL = no de-duplication). */
    dedupeKey: text("dedupe_key"),
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.availableAt),
    // At most one *active* job per key; finished jobs do not block new ones.
    uniqueIndex("jobs_active_dedupe_uq")
      .on(t.dedupeKey)
      .where(sql.raw(`status in ('pending', 'running')`)),
    check("jobs_status_ck", inList("status", JOB_STATUSES)),
    check("jobs_attempts_ck", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    githubDeliveryId: text("github_delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    repositoryFullName: text("repository_full_name"),
    payload: text("payload", { mode: "json" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("events_delivery_uq").on(t.githubDeliveryId),
    index("events_unprocessed_idx").on(t.processedAt),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    proposalVersion: integer("proposal_version").notNull(),
    decision: text("decision", { enum: DECISIONS }).notNull(),
    githubUser: text("github_user").notNull(),
    githubUserId: integer("github_user_id").notNull(),
    githubCommentId: integer("github_comment_id").notNull(),
    /** Instructions given with /ai revise. */
    instructions: text("instructions"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("decisions_comment_uq").on(t.githubCommentId),
    index("decisions_task_idx").on(t.taskId, t.proposalVersion),
    check("decisions_decision_ck", inList("decision", DECISIONS)),
  ],
);

/** Lease-based named locks (e.g. "repo:songbook"). Expired leases may be taken over. */
export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/** Fingerprints of feature ideas already proposed, to avoid repeating them. */
export const featureFingerprints = sqliteTable(
  "feature_fingerprints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    title: text("title").notNull(),
    githubIssueNumber: integer("github_issue_number"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("feature_fingerprints_repo_fp_uq").on(t.repositoryId, t.fingerprint)],
);

/** Runtime settings changeable without a restart (e.g. the kill switch). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: updatedAt(),
});

/** Append-only record of every important action. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repositoryId: text("repository_id"),
    taskId: integer("task_id"),
    action: text("action").notNull(),
    actor: text("actor").notNull().default("system"),
    details: text("details", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_task_idx").on(t.taskId),
    index("audit_log_repo_idx").on(t.repositoryId, t.createdAt),
  ],
);
