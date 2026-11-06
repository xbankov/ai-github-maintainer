import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication, type Application } from "../src/app.js";
import { lockHolder, repoLockName } from "../src/database/locks.js";
import { decisions, jobs, proposals, tasks } from "../src/database/schema.js";
import { setKillSwitch } from "../src/database/settings.js";
import { sessionUrl } from "../src/opencode/client.js";
import { enqueueImplementation } from "../src/orchestrator/implementation.js";
import { claimNext } from "../src/workers/queue.js";
import { FakeGitHub, TEST_PRIVATE_KEY, USERS } from "./fake-github.js";
import { defaultPlan, FakeOpenCode } from "./fake-opencode.js";
import { git, silentLogger, tempDir, testConfig } from "./helpers.js";

const WEB = "http://oc.test:4096";

/** A local git "remote" so worktrees, commits and pushes are real. */
function originRepo(): string {
  const base = tempDir();
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  git(base, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(base, "init", "-q", "--initial-branch=main", seed);
  writeFileSync(join(seed, "app.py"), "print('hi')\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "push", "-q", origin, "main");
  return origin;
}

const apps: Application[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup(
  opts: {
    batch?: number;
    retries?: number;
    dbPath?: string;
    gh?: FakeGitHub;
    oc?: FakeOpenCode;
  } = {},
) {
  const gh = opts.gh ?? new FakeGitHub();
  const oc = opts.oc ?? new FakeOpenCode();
  gh.originPath ||= originRepo();
  const config = testConfig({
    env: {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      ...(opts.dbPath ? { DATABASE_PATH: opts.dbPath } : {}),
    },
    file: {
      repositories: [{ id: "proj", owner: "xbankov", name: "repo" }],
      github: { authorized_users: ["xbankov", "VladoBaca"], api_url: "https://api.github.test" },
      discovery: { issue_batch_size: opts.batch ?? 1 },
      opencode: { server_url: "http://opencode.test:4096", web_url: WEB, operator: "xbankov" },
      limits: { max_implementation_retries: opts.retries ?? 2 },
    },
  });
  const app = await createApplication(config, silentLogger, {
    githubFetch: gh.http.fetch,
    opencodeFetch: oc.http.fetch,
    remoteUrl: () => `file://${gh.originPath}`,
  });
  apps.push(app);
  const drain = async () => {
    for (let i = 0; i < 100 && (await app.processor!.runOnce()); i++);
  };
  /** Makes deferred jobs due now (simulates time passing), then runs them. */
  const advance = async () => {
    app.db
      .update(jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(jobs.status, "pending"))
      .run();
    await drain();
  };
  /** One polling cycle: sync, then let every job run once more. */
  const cycle = async () => {
    app.scheduler!.enqueueSyncs("test");
    await drain();
    await advance();
  };
  const task = (issue: number) =>
    app.db.select().from(tasks).where(eq(tasks.githubIssueNumber, issue)).all().at(-1);
  return { app, gh, oc, cycle, drain, advance, task };
}

describe("conversation in OpenCode", () => {
  it("starts one session per allowed issue and links it on GitHub", async () => {
    const { gh, oc, cycle, task } = await setup();
    const n = gh.addIssue({ title: "search ignores accents", labeledBy: USERS.xbankov });
    await cycle();

    const s = oc.only();
    expect(s.title).toBe(`proj#${n} — search ignores accents`);
    expect(s.agent).toBe("maintainer-plan");
    expect(s.messages[0]!.metadata).toEqual({ source: "ai-maintainer" });
    expect(s.messages[0]!.text).toContain("search ignores accents");
    expect(existsSync(s.directory)).toBe(true); // the issue's worktree
    expect(task(n)).toMatchObject({ status: "AWAITING_APPROVAL", opencodeSessionId: s.id });
    expect(gh.botComments(n)).toEqual([`🤖 Working on this in OpenCode: ${sessionUrl(WEB, s.id)}`]);
    expect(gh.labelsOf(n)).toEqual(["ai:allowed", "ai:waiting-for-input"]);
  });

  it("works on one issue at a time and ignores issues not allowed by a maintainer", async () => {
    const { gh, oc, cycle, task } = await setup();
    const first = gh.addIssue({ title: "first", labeledBy: USERS.vlado });
    const second = gh.addIssue({ title: "second", labeledBy: USERS.xbankov });
    const stranger = gh.addIssue({ title: "stranger", labeledBy: USERS.stranger });
    const pr = gh.addIssue({ title: "a pr", labeledBy: USERS.xbankov, pullRequest: true });
    await cycle();
    expect(oc.sessions.size).toBe(1);
    expect(task(first)?.status).toBe("AWAITING_APPROVAL");
    expect(task(second)).toBeUndefined();
    expect(gh.labelsOf(second)).toEqual(["ai:allowed", "ai:queued"]);
    for (const i of [stranger, pr]) expect(task(i)).toBeUndefined();
  });

  it("shows whose turn it is with labels", async () => {
    const { gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "turns", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    oc.say(s.id, "Please also check the API", { busy: true });
    await advance();
    expect(task(n)?.status).toBe("ANALYZING");
    expect(gh.labelsOf(n)).toEqual(["ai:allowed", "ai:running"]);
    s.busy = false;
    await advance();
    expect(task(n)?.status).toBe("AWAITING_APPROVAL");
    // A pending question is the maintainer's turn even while the loop runs.
    s.busy = true;
    s.questions = 1;
    await advance();
    expect(task(n)?.status).toBe("AWAITING_APPROVAL");
  });

  it("notifies on GitHub only after 30 minutes without activity, once per wait", async () => {
    const { gh, oc, cycle, advance } = await setup();
    const n = gh.addIssue({ title: "quiet", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    await advance();
    expect(gh.botComments(n)).toHaveLength(1); // only "working on this"
    const notices = () => gh.botComments(n).filter((c) => c.includes("Waiting for your input"));
    oc.age(s.id, 31 * 60_000);
    await advance();
    await advance();
    expect(notices()).toEqual([`@xbankov 🤖 Waiting for your input: ${sessionUrl(WEB, s.id)}`]);
    // New activity starts a new waiting period.
    oc.say(s.id, "answer", { busy: true });
    await advance();
    s.busy = false;
    oc.age(s.id, 31 * 60_000);
    await advance();
    expect(notices()).toHaveLength(2);
  });

  it("forwards issue edits into the session", async () => {
    const { gh, oc, cycle } = await setup();
    const n = gh.addIssue({ title: "edit me", labeledBy: USERS.xbankov });
    await cycle();
    gh.edit(n, { body: "New details: only on mobile" });
    await cycle();
    const texts = oc.only().messages.map((m) => m.text ?? "");
    expect(texts.some((t) => t.includes("issue was edited") && t.includes("only on mobile"))).toBe(
      true,
    );
  });

  it("answers GitHub /ai commands from maintainers with the session link", async () => {
    const { gh, oc, cycle, task } = await setup();
    const n = gh.addIssue({ title: "where", labeledBy: USERS.xbankov });
    await cycle();
    gh.comment(n, USERS.xbankov, "/ai approve");
    gh.comment(n, USERS.stranger, "/ai approve");
    await cycle();
    expect(task(n)?.status).toBe("AWAITING_APPROVAL");
    const replies = gh.botComments(n).filter((c) => c.startsWith("🤖 Decisions are made"));
    expect(replies).toEqual([
      `🤖 Decisions are made in the OpenCode session: ${sessionUrl(WEB, oc.only().id)}`,
    ]);
  });

  it("/ai reject in the session declines the issue", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "nope", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai reject");
    await advance();
    expect(task(n)?.status).toBe("REJECTED");
    expect(app.db.select().from(decisions).get()).toMatchObject({
      decision: "reject",
      source: "opencode",
    });
    expect(gh.botComments(n).at(-1)).toContain("Declined by @xbankov in OpenCode");
    expect(gh.labelsOf(n)).toEqual(["ai:allowed"]);
  });

  it("refuses an approval without an implementable plan and tells the maintainer", async () => {
    const { gh, oc, cycle, advance, task } = await setup();
    oc.plan = () => JSON.stringify(defaultPlan("x", { valid: false, implementation: [] }));
    const n = gh.addIssue({ title: "vague", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai approve");
    await advance();
    expect(task(n)?.status).not.toBe("APPROVED");
    expect(oc.only().messages.some((m) => m.text?.includes("Approval not applied"))).toBe(true);
  });

  it("stops when the label is removed: closes the draft PR and cleans up", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    gh.ci = () => ({
      checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }],
      statuses: [],
    });
    const n = gh.addIssue({ title: "withdrawn", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai approve");
    await advance();
    await advance();
    expect(task(n)?.status).toBe("TESTING");
    const pr = task(n)!.githubPrNumber!;
    gh.unlabel(n, "ai:allowed");
    await cycle();
    expect(task(n)?.status).toBe("ABANDONED");
    expect(gh.pulls.get(pr)?.state).toBe("closed");
    expect(existsSync(oc.only().directory)).toBe(false);
    expect(lockHolder(app.db, repoLockName("proj"))).toBeNull();
  });
});

describe("approval and implementation", () => {
  it("/ai approve records the plan, implements, opens a draft PR and marks it ready after CI", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "fix search", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    const approveId = oc.say(s.id, "/ai approve");
    await advance(); // approval + implementation
    await advance(); // CI check

    expect(app.db.select().from(decisions).get()).toMatchObject({
      decision: "approve",
      source: "opencode",
      githubUser: "xbankov",
      sessionMessageId: approveId,
      proposalVersion: 1,
    });
    const plan = gh.botComments(n).find((c) => c.includes("Approved implementation plan v1"))!;
    expect(plan).toContain("Approved by @xbankov in the OpenCode session");
    expect(plan).toContain("#### Differences from the issue description");
    expect(plan).toContain("Also covers the import path");
    expect(app.db.select().from(proposals).get()?.status).toBe("approved");

    // Same session, now in build mode with edit rights.
    expect(oc.sessions.size).toBe(1);
    expect(s.agent).toBe("maintainer-build");
    expect(s.permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" });

    // Branch pushed, draft PR opened, CI passed, ready for review.
    const t = task(n)!;
    expect(t).toMatchObject({ status: "PR_OPEN", branchName: `ai/issue-${n}` });
    const pr = gh.pulls.get(t.githubPrNumber!)!;
    expect(pr).toMatchObject({ head: `ai/issue-${n}`, base: "main", draft: false, state: "open" });
    expect(pr.body).toContain(`Closes #${n}`);
    expect(git(gh.originPath, "log", "-1", "--format=%an", `ai/issue-${n}`)).toBe("maint[bot]");
    expect(gh.botComments(n).at(-1)).toContain(`Pull request #${pr.number} is ready for review`);
    expect(gh.labelsOf(n)).toEqual(["ai:allowed", "ai:waiting-for-review"]);
    // Never merged; the repository stays locked until the PR is merged or closed (Milestone 4).
    expect(lockHolder(app.db, repoLockName("proj"))).toBe(`task:${t.id}`);
  });

  it("fixes failing CI with the logs, then succeeds", async () => {
    const { gh, oc, cycle, advance, task } = await setup();
    let round = 0;
    gh.ci = () => ({
      checks: [
        {
          id: 7,
          name: "test",
          status: "completed",
          conclusion: round++ === 0 ? "failure" : "success",
        },
      ],
      statuses: [],
    });
    const n = gh.addIssue({ title: "flaky", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai approve");
    for (let i = 0; i < 4; i++) await advance();
    expect(task(n)).toMatchObject({ status: "PR_OPEN", ciAttempts: 1 });
    const prompts = oc
      .only()
      .messages.filter((m) => m.type === "user")
      .map((m) => m.text ?? "");
    expect(prompts.some((p) => p.includes("CI failed") && p.includes("assertion failed"))).toBe(
      true,
    );
    const prComments = gh.botComments(task(n)!.githubPrNumber!);
    expect(prComments.some((c) => c.includes("Fixing it — round 1 of 2"))).toBe(true);
  });

  it("gives up after the retry limit, frees the repository and asks for help", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup({ retries: 1 });
    gh.ci = () => ({
      checks: [{ id: 7, name: "test", status: "completed", conclusion: "failure" }],
      statuses: [],
    });
    const n = gh.addIssue({ title: "broken", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai approve");
    for (let i = 0; i < 6; i++) await advance();
    expect(task(n)?.status).toBe("FAILED");
    expect(gh.botComments(n).at(-1)).toContain("Implementation stopped");
    expect(lockHolder(app.db, repoLockName("proj"))).toBeNull();
  });

  it("marks the PR ready with a warning when the repository has no CI", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    gh.ci = () => ({ checks: [], statuses: [] });
    const n = gh.addIssue({ title: "no ci", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "/ai approve");
    await advance();
    expect(task(n)?.status).toBe("TESTING");
    // Pretend the grace period passed.
    app.db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(jobs.type, "await-ci"))
      .run();
    await advance();
    expect(task(n)?.status).toBe("PR_OPEN");
    expect(gh.botComments(task(n)!.githubPrNumber!).at(-1)).toContain("No CI checks ran");
  });

  it("discards changes to protected files", async () => {
    const { gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "sneaky", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    oc.say(s.id, "/ai approve");
    // The agent also edits CI config and a secret file.
    oc.extraFiles = { ".github/workflows/ci.yml": "evil: true\n", ".env": "SECRET=1\n" };
    await advance();
    const files = git(gh.originPath, "show", "--name-only", "--format=", `ai/issue-${n}`).split(
      "\n",
    );
    expect(files.some((f) => f.startsWith(".github/"))).toBe(false);
    expect(files).not.toContain(".env");
    expect(gh.pulls.get(task(n)!.githubPrNumber!)!.body).toContain(
      "Discarded changes to protected files",
    );
  });
});

describe("robustness", () => {
  it("recovers an interrupted conversation job when the workers start", async () => {
    const dbPath = join(tempDir(), "db.sqlite");
    const gh = new FakeGitHub();
    const oc = new FakeOpenCode();
    const first = await setup({ dbPath, gh, oc });
    const n = gh.addIssue({ title: "interrupted", labeledBy: USERS.xbankov });
    first.app.scheduler!.enqueueSyncs("test");
    await first.app.processor!.runOnce(); // sync: creates the task, queues the conversation
    expect(claimNext(first.app.db, "crashed-worker")?.type).toBe("conversation"); // then "crash"
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await setup({ dbPath, gh, oc });
    second.app.processor!.start();
    await waitFor(() => ["ANALYZING", "AWAITING_APPROVAL"].includes(second.task(n)?.status ?? ""));
    expect(oc.sessions.size).toBe(1);
  });

  it("does nothing while the kill switch is on", async () => {
    const { app, gh, cycle, task } = await setup();
    setKillSwitch(app.db, true, "test");
    const n = gh.addIssue({ title: "paused", labeledBy: USERS.xbankov });
    await cycle();
    expect(task(n)).toBeUndefined();
    expect(app.db.select().from(jobs).all()).toEqual([]);
  });

  it("never implements without a recorded approval", async () => {
    const { app, gh, cycle, task } = await setup();
    const n = gh.addIssue({ title: "sneaky approval", labeledBy: USERS.xbankov });
    await cycle();
    const id = task(n)!.id;
    // Force the task to APPROVED without a decision.
    app.db
      .update(tasks)
      .set({ status: "APPROVED", proposalVersion: 1, approvedVersion: 1 })
      .where(eq(tasks.id, id))
      .run();
    app.db
      .insert(proposals)
      .values({
        taskId: id,
        version: 1,
        content: defaultPlan("x"),
        fingerprint: "f",
        status: "approved",
      })
      .run();
    enqueueImplementation(app.orchestrator!, task(n)!);
    for (let i = 0; i < 3; i++) await app.processor!.runOnce();
    expect(app.db.select().from(jobs).where(eq(jobs.type, "implement-task")).get()?.status).toBe(
      "dead",
    );
    expect(gh.pulls.size).toBe(0);
  });
});
