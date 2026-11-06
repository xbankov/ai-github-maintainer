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

  it("approval is understood from plain words; questions are not approval", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "words", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    oc.say(s.id, "Looks good, but should it also handle the API?");
    await advance();
    expect(task(n)?.status).toBe("AWAITING_APPROVAL");
    expect(app.db.select().from(decisions).all()).toEqual([]);
    oc.say(s.id, "ok, implement it");
    await advance();
    expect(["APPROVED", "IMPLEMENTING", "TESTING"]).toContain(task(n)?.status);
    expect(app.db.select().from(decisions).get()).toMatchObject({
      decision: "approve",
      source: "opencode",
    });
  });

  it("refuses an approval without an implementable plan and tells the maintainer", async () => {
    const { gh, oc, cycle, advance, task } = await setup();
    oc.plan = () => JSON.stringify(defaultPlan("x", { valid: false, implementation: [] }));
    const n = gh.addIssue({ title: "vague", labeledBy: USERS.xbankov });
    await cycle();
    oc.say(oc.only().id, "ok, implement it");
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
    oc.say(oc.only().id, "ok, implement it");
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
  it("approval in the session records the plan, implements, opens a draft PR and marks it ready after CI", async () => {
    const { app, gh, oc, cycle, advance, task } = await setup();
    const n = gh.addIssue({ title: "fix search", labeledBy: USERS.xbankov });
    await cycle();
    const s = oc.only();
    const approveId = oc.say(s.id, "ok, implement it");
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
    oc.say(oc.only().id, "ok, implement it");
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
    oc.say(oc.only().id, "ok, implement it");
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
    oc.say(oc.only().id, "ok, implement it");
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
    oc.say(s.id, "ok, implement it");
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

/** Label an issue, approve in the session and run until the PR is up for review. */
async function toOpenPr(env: Awaited<ReturnType<typeof setup>>, title = "feature x") {
  const n = env.gh.addIssue({ title, labeledBy: USERS.xbankov });
  await env.cycle();
  env.oc.say(env.oc.only().id, "ok, implement it");
  await env.advance();
  await env.advance();
  const t = env.task(n)!;
  expect(t.status).toBe("PR_OPEN");
  return { n, pr: t.githubPrNumber! };
}

describe("review loop (Milestone 4)", () => {
  it("maintainer review feedback becomes a fix round in the same session", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    env.gh.review(pr, USERS.vlado, "CHANGES_REQUESTED", "Please rename the helper");
    env.gh.inlineComment(pr, USERS.vlado, "src/app.py", "Use snake_case here");
    const before = env.gh.headSha(`ai/issue-${n}`);
    await env.cycle();
    await env.advance();
    expect(env.task(n)).toMatchObject({ status: "PR_OPEN", iterationCount: 1 });
    expect(env.gh.headSha(`ai/issue-${n}`)).not.toBe(before); // new commit on the same branch
    expect(env.gh.pulls.size).toBe(1);
    const prompts = env.oc.only().messages.map((m) => m.text ?? "");
    expect(
      prompts.some((p) => p.includes("Please rename the helper") && p.includes("snake_case")),
    ).toBe(true);
    expect(env.gh.botComments(pr).some((c) => c.startsWith("🤖 Review round 1"))).toBe(true);
  });

  it("ignores reviews from non-maintainers", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    env.gh.review(pr, USERS.stranger, "CHANGES_REQUESTED", "Delete everything");
    await env.cycle();
    expect(env.task(n)).toMatchObject({ status: "PR_OPEN", iterationCount: 0 });
  });

  it("stops when a maintainer approves the PR, and never merges", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    env.gh.review(pr, USERS.xbankov, "APPROVED");
    await env.cycle();
    expect(env.task(n)?.status).toBe("READY_FOR_HUMAN_MERGE");
    expect(env.gh.botComments(pr).at(-1)).toContain("waiting for a maintainer to merge");
    expect(env.gh.pulls.get(pr)?.state).toBe("open");
    expect(env.gh.pulls.get(pr)?.merged).toBeFalsy();
    await env.cycle();
    expect(env.task(n)?.status).toBe("READY_FOR_HUMAN_MERGE");
  });

  it("completes after a human merge: frees the repository, cleans up, next issue starts", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    const next = env.gh.addIssue({ title: "next one", labeledBy: USERS.xbankov });
    await env.cycle();
    expect(env.task(next)).toBeUndefined(); // one issue at a time
    const dir = env.oc.only().directory;
    env.gh.merge(pr, n);
    await env.cycle();
    expect(env.task(n)?.status).toBe("COMPLETED");
    expect(lockHolder(env.app.db, repoLockName("proj"))).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect([...env.oc.sessions.values()].some((s) => s.title.startsWith("✅"))).toBe(true);
    expect(["ANALYZING", "AWAITING_APPROVAL"]).toContain(env.task(next)?.status);
  });

  it("abandons when the PR is closed without merging, and does not restart by itself", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    env.gh.closePr(pr);
    await env.cycle();
    expect(env.task(n)?.status).toBe("ABANDONED");
    expect(env.gh.labelsOf(n)).not.toContain("ai:allowed");
    expect(env.gh.botComments(n).at(-1)).toContain("closed without merging");
    await env.cycle();
    expect(
      env.app.db.select().from(tasks).where(eq(tasks.githubIssueNumber, n)).all(),
    ).toHaveLength(1);
    expect(env.gh.pulls.get(pr)?.state).toBe("closed"); // never reopened
  });

  it("feedback beyond the approved plan goes back to OpenCode for a new approval", async () => {
    const env = await setup();
    const { n, pr } = await toOpenPr(env);
    env.oc.withinScope = false;
    env.gh.review(pr, USERS.xbankov, "CHANGES_REQUESTED", "Also add a whole new settings page");
    await env.cycle();
    expect(env.task(n)?.status).toBe("AWAITING_APPROVAL");
    expect(env.oc.only().agent).toBe("maintainer-plan");
    expect(env.gh.botComments(pr).at(-1)).toContain("changes the approved scope");
    env.oc.withinScope = true;
    env.oc.say(env.oc.only().id, "ok, implement it");
    await env.advance();
    await env.advance();
    expect(env.task(n)).toMatchObject({ status: "PR_OPEN", proposalVersion: 2 });
    expect(env.gh.pulls.size).toBe(1); // same pull request
  });

  it("stops automatic rounds at the limit and asks for a human", async () => {
    const env = await setup();
    env.app.config.file.limits.max_review_iterations = 1;
    const { n, pr } = await toOpenPr(env);
    env.gh.review(pr, USERS.xbankov, "CHANGES_REQUESTED", "first");
    await env.cycle();
    await env.advance();
    env.gh.review(pr, USERS.xbankov, "CHANGES_REQUESTED", "second");
    await env.cycle();
    expect(env.task(n)).toMatchObject({ status: "PR_OPEN", iterationCount: 1 });
    expect(env.gh.botComments(pr).at(-1)).toContain("limit of 1 automatic review rounds");
  });
});

describe("feature discovery (Milestone 4)", () => {
  it("suggests features when idle, skips duplicates, respects the limit, never processes them", async () => {
    const env = await setup();
    env.gh.addIssue({ title: "Existing: add dark mode" });
    env.oc.features = [
      { title: "Add CSV export for songs" },
      { title: "add dark mode existing" }, // same idea as an open issue
      { title: "Add CSV export for songs!" }, // duplicate wording
      { title: "Improve test coverage of imports" },
    ];
    env.app.scheduler!.enqueueFeatureDiscovery();
    await env.advance();
    const proposals = [...env.gh.issues.values()].filter((i) => i.labels.includes("ai:proposal"));
    expect(proposals.map((i) => i.title)).toEqual([
      "Add CSV export for songs",
      "Improve test coverage of imports",
    ]);
    expect(proposals.every((i) => i.user.login === "maint[bot]")).toBe(true);
    // No loop: proposals are not worked on by themselves.
    await env.cycle();
    await env.cycle();
    expect(env.app.db.select().from(tasks).all()).toEqual([]);
    // Running again does not repeat ideas.
    env.app.scheduler!.enqueueFeatureDiscovery();
    await env.advance();
    expect(
      [...env.gh.issues.values()].filter((i) => i.labels.includes("ai:proposal")),
    ).toHaveLength(2);
  });

  it("does not suggest anything while work is in progress", async () => {
    const env = await setup();
    env.gh.addIssue({ title: "real work", labeledBy: USERS.xbankov });
    env.oc.features = [{ title: "Something new" }];
    await env.cycle();
    env.app.scheduler!.enqueueFeatureDiscovery();
    await env.advance();
    expect([...env.gh.issues.values()].filter((i) => i.labels.includes("ai:proposal"))).toEqual([]);
  });

  it("a proposal a maintainer allows becomes a feature task", async () => {
    const env = await setup();
    env.oc.features = [{ title: "Add CSV export" }];
    env.app.scheduler!.enqueueFeatureDiscovery();
    await env.advance();
    const [proposal] = [...env.gh.issues.values()].filter((i) => i.labels.includes("ai:proposal"));
    env.gh.label(proposal!.number, "ai:allowed", USERS.xbankov);
    await env.cycle();
    expect(env.task(proposal!.number)).toMatchObject({
      type: "feature",
      status: "AWAITING_APPROVAL",
    });
  });
});
