import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database/client.js";
import { jobs } from "../src/database/schema.js";
import { JobProcessor } from "../src/workers/processor.js";
import { enqueue } from "../src/workers/queue.js";
import { silentLogger } from "./helpers.js";

describe("job processor", () => {
  it("cancels a timed-out handler and waits for it before releasing the job", async () => {
    const db = openDatabase({ path: ":memory:" });
    enqueue(db, { type: "slow", payload: {} });
    const timeline: string[] = [];
    const processor = new JobProcessor({
      db,
      logger: silentLogger,
      envPaused: false,
      jobTimeoutMs: 50,
      handlers: {
        slow: async (_job, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          timeline.push("aborted");
          await new Promise((r) => setTimeout(r, 100)); // cleanup takes a while
          timeline.push("handler settled");
        },
      },
    });
    await processor.runOnce();
    timeline.push("job released");
    expect(timeline).toEqual(["aborted", "handler settled", "job released"]);
    expect(db.select().from(jobs).get()).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining("timed out"),
    });
  });

  it("a handler that ignores the abort still cannot overlap its retry", async () => {
    const db = openDatabase({ path: ":memory:" });
    enqueue(db, { type: "stubborn", payload: {} });
    let running = 0;
    let maxConcurrent = 0;
    const processor = new JobProcessor({
      db,
      logger: silentLogger,
      envPaused: false,
      jobTimeoutMs: 20,
      handlers: {
        stubborn: async () => {
          running++;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((r) => setTimeout(r, 60));
          running--;
        },
      },
    });
    await processor.runOnce();
    db.update(jobs)
      .set({ availableAt: new Date(0) })
      .run();
    await processor.runOnce();
    expect(maxConcurrent).toBe(1);
  });
});
