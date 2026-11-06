/**
 * Task lifecycle state machine (SPEC §6).
 *
 * Every status change must go through `assertTransition`. A transition is only
 * valid for a specific *trigger* — the event that justifies it — so webhook
 * payloads can never set an arbitrary status: handlers translate verified
 * events into triggers, and the table below decides what is allowed.
 */

export const TASK_STATES = [
  "DISCOVERED",
  "ANALYZING",
  "AWAITING_APPROVAL",
  "REJECTED",
  "APPROVED",
  "IMPLEMENTING",
  "TESTING",
  "PR_OPEN",
  "CHANGES_REQUESTED",
  "READY_FOR_HUMAN_MERGE",
  "COMPLETED",
  "ABANDONED",
  "FAILED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TRANSITION_TRIGGERS = [
  "analysis_started",
  "analysis_completed",
  "analysis_failed",
  "conversation_continued",
  "approve_command",
  "reject_command",
  "revise_command",
  "issue_changed",
  "issue_closed",
  "implementation_started",
  "implementation_finished",
  "checks_failed",
  "pr_opened",
  "implementation_failed",
  "review_changes_requested",
  "scope_change_requested",
  "pr_approved",
  "pr_merged",
  "pr_closed_unmerged",
  "manual_retry",
  "manual_abandon",
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

/** States from which no further automatic work happens. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["COMPLETED", "ABANDONED"]);

/** States that count as "being processed" for discovery de-duplication. */
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(
  TASK_STATES.filter((s) => !TERMINAL_STATES.has(s) && s !== "REJECTED"),
);

type TransitionTable = Partial<
  Record<TaskState, Partial<Record<TaskState, readonly TransitionTrigger[]>>>
>;

/**
 * from → to → triggers that may cause it.
 * Notable rules (SPEC §6):
 *  - only AWAITING_APPROVAL → APPROVED, and only via an approval command
 *  - only APPROVED → IMPLEMENTING
 *  - review states are only reachable from PR_OPEN / CHANGES_REQUESTED
 *  - COMPLETED only via a confirmed merge event
 *  - nothing ever leaves READY_FOR_HUMAN_MERGE automatically except merge/close
 */
const TRANSITIONS: TransitionTable = {
  DISCOVERED: {
    ANALYZING: ["analysis_started"],
    ABANDONED: ["issue_closed", "manual_abandon"],
  },
  ANALYZING: {
    AWAITING_APPROVAL: ["analysis_completed"],
    FAILED: ["analysis_failed"],
    ABANDONED: ["issue_closed", "manual_abandon"],
  },
  AWAITING_APPROVAL: {
    APPROVED: ["approve_command"],
    // The maintainer replied in the OpenCode session; the agent works again.
    ANALYZING: ["revise_command", "issue_changed", "conversation_continued"],
    REJECTED: ["reject_command"],
    ABANDONED: ["issue_closed", "manual_abandon"],
  },
  REJECTED: {
    // A rejected task is only reconsidered when the issue itself changes or a human asks for a revision.
    ANALYZING: ["revise_command", "issue_changed"],
    ABANDONED: ["issue_closed", "manual_abandon"],
  },
  APPROVED: {
    IMPLEMENTING: ["implementation_started"],
    // The issue changed, or a maintainer asked for a revision, after approval:
    // the approval no longer matches — re-analyse and require a new approval.
    ANALYZING: ["issue_changed", "revise_command"],
    FAILED: ["implementation_failed"],
    ABANDONED: ["issue_closed", "manual_abandon"],
  },
  IMPLEMENTING: {
    TESTING: ["implementation_finished"],
    FAILED: ["implementation_failed"],
    ABANDONED: ["issue_closed", "pr_closed_unmerged", "manual_abandon"],
  },
  TESTING: {
    IMPLEMENTING: ["checks_failed"],
    PR_OPEN: ["pr_opened"],
    FAILED: ["implementation_failed"],
    ABANDONED: ["issue_closed", "pr_closed_unmerged", "manual_abandon"],
  },
  PR_OPEN: {
    CHANGES_REQUESTED: ["review_changes_requested"],
    READY_FOR_HUMAN_MERGE: ["pr_approved"],
    COMPLETED: ["pr_merged"],
    ABANDONED: ["pr_closed_unmerged", "manual_abandon"],
  },
  CHANGES_REQUESTED: {
    IMPLEMENTING: ["implementation_started"],
    // Feedback goes beyond the approved scope: a new proposal version must be approved first.
    AWAITING_APPROVAL: ["scope_change_requested"],
    READY_FOR_HUMAN_MERGE: ["pr_approved"],
    COMPLETED: ["pr_merged"],
    FAILED: ["implementation_failed"],
    ABANDONED: ["pr_closed_unmerged", "manual_abandon"],
  },
  READY_FOR_HUMAN_MERGE: {
    COMPLETED: ["pr_merged"],
    ABANDONED: ["pr_closed_unmerged", "manual_abandon"],
  },
  FAILED: {
    // Only a human can resume failed work.
    ANALYZING: ["manual_retry"],
    APPROVED: ["manual_retry"],
    PR_OPEN: ["manual_retry"],
    COMPLETED: ["pr_merged"],
    ABANDONED: ["issue_closed", "pr_closed_unmerged", "manual_abandon"],
  },
  COMPLETED: {},
  ABANDONED: {},
};

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
    readonly trigger: TransitionTrigger,
  ) {
    super(`Invalid task transition ${from} → ${to} (trigger: ${trigger})`);
  }
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function canTransition(from: TaskState, to: TaskState, trigger: TransitionTrigger): boolean {
  return TRANSITIONS[from]?.[to]?.includes(trigger) ?? false;
}

export function assertTransition(from: TaskState, to: TaskState, trigger: TransitionTrigger): void {
  if (!canTransition(from, to, trigger)) throw new InvalidTransitionError(from, to, trigger);
}

/** All target states reachable from `from` (for diagnostics and tests). */
export function allowedTargets(from: TaskState): TaskState[] {
  return Object.keys(TRANSITIONS[from] ?? {}) as TaskState[];
}
