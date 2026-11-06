import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATES,
  allowedTargets,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  TASK_STATES,
  TERMINAL_STATES,
  TRANSITION_TRIGGERS,
  type TaskState,
} from "../src/orchestrator/state-machine.js";

/** Every (from, to) pair reachable by some trigger. */
function reachable(): Array<[TaskState, TaskState]> {
  const pairs: Array<[TaskState, TaskState]> = [];
  for (const from of TASK_STATES)
    for (const to of TASK_STATES)
      if (TRANSITION_TRIGGERS.some((t) => canTransition(from, to, t))) pairs.push([from, to]);
  return pairs;
}

describe("task state machine", () => {
  it("allows the happy path with the right triggers", () => {
    const path: Array<[TaskState, TaskState, (typeof TRANSITION_TRIGGERS)[number]]> = [
      ["DISCOVERED", "ANALYZING", "analysis_started"],
      ["ANALYZING", "AWAITING_APPROVAL", "analysis_completed"],
      ["AWAITING_APPROVAL", "APPROVED", "approve_command"],
      ["APPROVED", "IMPLEMENTING", "implementation_started"],
      ["IMPLEMENTING", "TESTING", "implementation_finished"],
      ["TESTING", "PR_OPEN", "pr_opened"],
      ["PR_OPEN", "CHANGES_REQUESTED", "review_changes_requested"],
      ["CHANGES_REQUESTED", "IMPLEMENTING", "implementation_started"],
      ["IMPLEMENTING", "TESTING", "implementation_finished"],
      ["TESTING", "PR_OPEN", "pr_opened"],
      ["PR_OPEN", "READY_FOR_HUMAN_MERGE", "pr_approved"],
      ["READY_FOR_HUMAN_MERGE", "COMPLETED", "pr_merged"],
    ];
    for (const [from, to, trigger] of path)
      expect(() => assertTransition(from, to, trigger)).not.toThrow();
  });

  it("only AWAITING_APPROVAL can become APPROVED, and only by an approval command", () => {
    const sources = reachable()
      .filter(([, to]) => to === "APPROVED")
      .map(([from]) => from);
    expect(sources.sort()).toEqual(["AWAITING_APPROVAL", "FAILED"]);
    // FAILED → APPROVED is a manual retry of already-approved work, not a new approval.
    expect(canTransition("FAILED", "APPROVED", "approve_command")).toBe(false);
    for (const trigger of TRANSITION_TRIGGERS) {
      expect(canTransition("AWAITING_APPROVAL", "APPROVED", trigger)).toBe(
        trigger === "approve_command",
      );
    }
  });

  it("only APPROVED (or a review iteration) can start implementation", () => {
    const sources = reachable()
      .filter(([, to]) => to === "IMPLEMENTING")
      .map(([from]) => from);
    expect(sources.sort()).toEqual(["APPROVED", "CHANGES_REQUESTED", "TESTING"]);
    expect(canTransition("REJECTED", "IMPLEMENTING", "implementation_started")).toBe(false);
    expect(canTransition("AWAITING_APPROVAL", "IMPLEMENTING", "implementation_started")).toBe(
      false,
    );
  });

  it("review states are only reachable from PR_OPEN / CHANGES_REQUESTED", () => {
    for (const target of ["CHANGES_REQUESTED", "READY_FOR_HUMAN_MERGE"] as const) {
      const sources = reachable()
        .filter(([, to]) => to === target)
        .map(([from]) => from);
      for (const s of sources) expect(["PR_OPEN", "CHANGES_REQUESTED"]).toContain(s);
    }
  });

  it("COMPLETED requires a confirmed merge event", () => {
    for (const from of TASK_STATES)
      for (const trigger of TRANSITION_TRIGGERS)
        if (canTransition(from, "COMPLETED", trigger)) expect(trigger).toBe("pr_merged");
  });

  it("READY_FOR_HUMAN_MERGE never leads anywhere but merge or close", () => {
    expect(allowedTargets("READY_FOR_HUMAN_MERGE").sort()).toEqual(["ABANDONED", "COMPLETED"]);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const s of TERMINAL_STATES) expect(allowedTargets(s)).toEqual([]);
  });

  it("a rejected task cannot be approved or implemented without re-analysis", () => {
    expect(allowedTargets("REJECTED").sort()).toEqual(["ABANDONED", "ANALYZING"]);
  });

  it("FAILED is only left by a human retry, a merge, or closing", () => {
    for (const to of allowedTargets("FAILED")) {
      const triggers = TRANSITION_TRIGGERS.filter((t) => canTransition("FAILED", to, t));
      for (const t of triggers)
        expect([
          "manual_retry",
          "manual_abandon",
          "pr_merged",
          "issue_closed",
          "pr_closed_unmerged",
        ]).toContain(t);
    }
  });

  it("throws a descriptive error for invalid transitions", () => {
    expect(() => assertTransition("DISCOVERED", "COMPLETED", "pr_merged")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("DISCOVERED", "COMPLETED", "pr_merged")).toThrow(
      "Invalid task transition DISCOVERED → COMPLETED (trigger: pr_merged)",
    );
  });

  it("active states exclude terminal and rejected states", () => {
    expect(ACTIVE_STATES.has("COMPLETED")).toBe(false);
    expect(ACTIVE_STATES.has("ABANDONED")).toBe(false);
    expect(ACTIVE_STATES.has("REJECTED")).toBe(false);
    expect(ACTIVE_STATES.has("AWAITING_APPROVAL")).toBe(true);
    expect(ACTIVE_STATES.has("FAILED")).toBe(true);
  });
});
