import { eq } from "drizzle-orm";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type Db } from "../src/database/client.js";
import { syncRepositories } from "../src/database/repositories.js";
import {
  auditLog,
  decisions,
  events,
  jobs,
  proposals,
  repositories,
  tasks,
} from "../src/database/schema.js";
import { getKillSwitch, setKillSwitch } from "../src/database/settings.js";
import { StaleTaskError, transitionTask } from "../src/database/tasks.js";
import { InvalidTransitionError } from "../src/orchestrator/state-machine.js";
import { parseFileConfig } from "../src/config/load.js";
import { baseFileConfig, tempDir } from "./helpers.js";

const repos = parseFileConfig(baseFileConfig).repositories;

function freshDb(): Db {
  const db = openDatabase({ path: ":memory:" });
  syncRepositories(db, repos);
  return db;
}

function insertTask(db: Db, issue = 1, status: typeof tasks.$inferInsert.status = "DISCOVERED") {
  return db
    .insert(tasks)
    .values({ repositoryId: "songbook", type: "issue", githubIssueNumber: issue, status })
    .returning()
    .get();
}

describe("database", () => {
  it("applies migrations to a file database, enables WAL and foreign keys, and reopens", () => {
    const path = join(tempDir(), "nested", "db.sqlite");
    const db = openDatabase({ path });
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    syncRepositories(db, repos);
    closeDatabase(db);
    const again = openDatabase({ path }); // migrations are idempotent
    expect(again.select().from(repositories).all()).toHaveLength(2);
    closeDatabase(again);
  });

  it("enforces foreign keys", () => {
    const db = freshDb();
    expect(() =>
      db.insert(tasks).values({ repositoryId: "nope", type: "issue", githubIssueNumber: 1 }).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("allows only one live task per issue, but a new one after completion", () => {
    const db = freshDb();
    insertTask(db, 7);
    expect(() => insertTask(db, 7)).toThrow(/UNIQUE/);
    db.update(tasks).set({ status: "ABANDONED" }).where(eq(tasks.githubIssueNumber, 7)).run();
    expect(() => insertTask(db, 7)).not.toThrow();
  });

  it("rejects unknown statuses at the database level", () => {
    const db = freshDb();
    expect(() =>
      db.$client
        .prepare(
          "insert into tasks (repository_id, type, github_issue_number, status) values ('songbook','issue',1,'MERGED')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("enforces unique proposal versions and approved_version <= proposal_version", () => {
    const db = freshDb();
    const task = insertTask(db);
    db.insert(proposals)
      .values({ taskId: task.id, version: 1, content: { a: 1 }, fingerprint: "f1" })
      .run();
    expect(() =>
      db
        .insert(proposals)
        .values({ taskId: task.id, version: 1, content: {}, fingerprint: "f2" })
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.update(tasks).set({ approvedVersion: 1 }).where(eq(tasks.id, task.id)).run(),
    ).toThrow(/CHECK/);
    db.update(tasks)
      .set({ proposalVersion: 1, approvedVersion: 1 })
      .where(eq(tasks.id, task.id))
      .run();
  });

  it("deduplicates webhook deliveries, decisions per comment, and jobs per key", () => {
    const db = freshDb();
    db.insert(events).values({ githubDeliveryId: "d-1", eventType: "issues", payload: {} }).run();
    expect(() =>
      db.insert(events).values({ githubDeliveryId: "d-1", eventType: "issues", payload: {} }).run(),
    ).toThrow(/UNIQUE/);

    const task = insertTask(db);
    const decision = {
      taskId: task.id,
      proposalVersion: 1,
      decision: "approve" as const,
      githubUser: "xbankov",
      githubUserId: 1,
      githubCommentId: 99,
    };
    db.insert(decisions).values(decision).run();
    expect(() => db.insert(decisions).values(decision).run()).toThrow(/UNIQUE/);

    db.insert(jobs).values({ type: "discover", payload: {}, dedupeKey: "k" }).run();
    expect(() =>
      db.insert(jobs).values({ type: "discover", payload: {}, dedupeKey: "k" }).run(),
    ).toThrow(/UNIQUE/);
    db.insert(jobs)
      .values([
        { type: "x", payload: {} },
        { type: "x", payload: {} },
      ])
      .run(); // NULL keys never collide
  });

  it("stores JSON payloads and millisecond timestamps", () => {
    const db = freshDb();
    const before = Date.now();
    const job = db
      .insert(jobs)
      .values({ type: "t", payload: { n: 1, s: "x" } })
      .returning()
      .get();
    expect(job.payload).toEqual({ n: 1, s: "x" });
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(job.status).toBe("pending");
  });
});

describe("repository sync", () => {
  it("adds, updates and disables — never deletes", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(syncRepositories(db, repos)).toEqual({
      added: ["songbook", "home-server"],
      updated: [],
      disabled: [],
    });
    expect(syncRepositories(db, repos)).toEqual({ added: [], updated: [], disabled: [] });

    const changed = [{ ...repos[0]!, default_branch: "trunk" }];
    expect(syncRepositories(db, changed)).toEqual({
      added: [],
      updated: ["songbook"],
      disabled: ["home-server"],
    });
    const rows = db.select().from(repositories).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "home-server")?.enabled).toBe(false);
    expect(rows.find((r) => r.id === "songbook")?.defaultBranch).toBe("trunk");
    expect(
      db.select().from(auditLog).where(eq(auditLog.action, "repositories.synced")).all(),
    ).toHaveLength(2);
  });
});

describe("task transitions", () => {
  it("applies valid transitions atomically with patch and audit entry", () => {
    const db = freshDb();
    const task = insertTask(db);
    transitionTask(db, { taskId: task.id, to: "ANALYZING", trigger: "analysis_started" });
    const updated = transitionTask(db, {
      taskId: task.id,
      to: "AWAITING_APPROVAL",
      trigger: "analysis_completed",
      patch: { proposalVersion: 1 },
    });
    expect(updated.status).toBe("AWAITING_APPROVAL");
    expect(updated.proposalVersion).toBe(1);
    const audit = db.select().from(auditLog).where(eq(auditLog.taskId, task.id)).all();
    expect(audit.map((a) => a.details)).toEqual([
      { from: "DISCOVERED", to: "ANALYZING", trigger: "analysis_started" },
      { from: "ANALYZING", to: "AWAITING_APPROVAL", trigger: "analysis_completed" },
    ]);
  });

  it("rejects invalid transitions without changing anything", () => {
    const db = freshDb();
    const task = insertTask(db, 1, "AWAITING_APPROVAL");
    expect(() =>
      transitionTask(db, { taskId: task.id, to: "COMPLETED", trigger: "pr_merged" }),
    ).toThrow(InvalidTransitionError);
    expect(db.select().from(tasks).where(eq(tasks.id, task.id)).get()?.status).toBe(
      "AWAITING_APPROVAL",
    );
    expect(db.select().from(auditLog).where(eq(auditLog.taskId, task.id)).all()).toHaveLength(0);
  });

  it("sets completed_at on terminal states", () => {
    const db = freshDb();
    const task = insertTask(db, 1, "READY_FOR_HUMAN_MERGE");
    const done = transitionTask(db, { taskId: task.id, to: "COMPLETED", trigger: "pr_merged" });
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it("detects concurrent modification", () => {
    const db = freshDb();
    const task = insertTask(db);
    // Simulate another writer changing the status between read and update.
    db.$client.exec(
      `create trigger sneaky before update on tasks begin update tasks set status = 'ABANDONED' where id = new.id and old.status = 'DISCOVERED' and new.status = 'ANALYZING'; select raise(ignore); end;`,
    );
    expect(() =>
      transitionTask(db, { taskId: task.id, to: "ANALYZING", trigger: "analysis_started" }),
    ).toThrow(StaleTaskError);
  });
});

describe("kill switch", () => {
  it("defaults to running, persists pause/resume and audits it", () => {
    const db = freshDb();
    expect(getKillSwitch(db, false).paused).toBe(false);
    setKillSwitch(db, true, "test", "maintenance");
    expect(getKillSwitch(db, false)).toEqual({
      paused: true,
      source: "database",
      reason: "maintenance",
    });
    setKillSwitch(db, false, "test");
    expect(getKillSwitch(db, false).paused).toBe(false);
    expect(
      db
        .select()
        .from(auditLog)
        .all()
        .filter((a) => a.action.startsWith("killswitch")),
    ).toHaveLength(2);
  });

  it("environment pause overrides the database", () => {
    const db = freshDb();
    setKillSwitch(db, false, "test");
    expect(getKillSwitch(db, true)).toMatchObject({ paused: true, source: "env" });
  });
});
