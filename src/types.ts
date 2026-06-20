// Core domain types for the harness.
// The thread state model is §7 of the spec; everything else supports it.

export type ThreadRole = "orchestrator" | "worker" | "reviewer" | "watcher";

export type ThreadStatus =
  | "planning"
  | "implementing"
  | "awaiting_review"
  | "fixing"
  | "approved"
  | "merged"
  | "done" // linear goal_loop reached its goal (§5C)
  | "abandoned"
  | "halted"; // tripped a guard (§9)

export interface PrState {
  number: number;
  headSha: string;
  /** GitHub check rollup: e.g. "SUCCESS" | "FAILURE" | "PENDING" | null. */
  checks: string | null;
  /** Count of approving reviews. */
  approvals: number;
  /** True once mergeable + required approvals satisfied. */
  mergeable: boolean;
}

export interface BudgetState {
  /** Output tokens consumed by this thread's agent runs so far. */
  tokensUsed: number;
  /** Heartbeat iterations this thread has driven. */
  iterations: number;
  /** Epoch ms when the thread started. */
  startedAt: number;
}

/** §7 Thread State Model. The unit the heartbeat reasons over. */
export interface Thread {
  id: string;
  role: ThreadRole;
  worktree: string | null;
  pieceId: string | null;
  pr: PrState | null;
  status: ThreadStatus;
  /** Reviewer spawns only when the head moves past this sha. */
  lastReviewedSha: string | null;
  /** Operator kill-switch, honored across processes via the state file (§9). */
  killRequested: boolean;
  budget: BudgetState;
  /** Loop decision state that must survive restarts (§5C, §9). */
  loopState?: LoopState;
  /** Free-form notes the loop accumulates (e.g. why it was halted). */
  notes: string[];
}

/**
 * Per-loop decision state that must survive a process restart or a `--once`
 * cron cadence — otherwise a loop silently resets its progress and guards.
 * Persisted on the owning thread.
 */
export interface LoopState {
  /** goal_loop (§5C): continuation note handed to the next turn. */
  lastNext?: string;
  /** goal_loop: last summary, for no-progress detection. */
  lastSummary?: string;
  /** goal_loop: consecutive no-progress turns (the §9 divergence streak). */
  noProgress?: number;
  /** single-PR monitor: area -> fix attempts, for divergence detection (§9). */
  touchCounts?: Record<string, number>;
  /**
   * single-PR monitor: ids of findings already resolved. Kept compactly (ids
   * only) so the findings array can hold just unresolved items, while still
   * deduping a bot comment we've already addressed. Prevents unbounded growth.
   */
  resolvedFindingIds?: string[];
}

/**
 * A single actionable, still-unresolved item a reviewer (bot, human, or
 * reviewer thread) raised. The monitor compacts findings on resolution — it
 * drops them from the array and records their ids in
 * `LoopState.resolvedFindingIds` — so anything present here is open by
 * construction; there is no `resolved` flag to check.
 */
export interface ReviewFinding {
  id: string;
  source: "review-bot" | "human" | "reviewer-thread";
  /** Stable-ish key used for divergence detection: file:line or topic. */
  area: string;
  body: string;
  /**
   * GraphQL node id of the PR review thread this came from, when it's an inline
   * review comment. Lets the monitor resolve the thread (clearing the
   * "require conversation resolution" merge gate) once the finding is fixed.
   * Absent for top-level issue comments and the harness's own reviewer thread.
   */
  threadId?: string;
}

/** What a spawned agent thread returns when it finishes a turn. */
export interface ThreadResult {
  ok: boolean;
  /** Final text / summary the agent produced. */
  text: string;
  /** Output tokens this run consumed, if the runner can report it. */
  tokensUsed: number;
  /** Anything the runner could not classify, surfaced for logging. */
  raw?: unknown;
}

/** Persisted top-level harness state. */
export interface HarnessState {
  threads: Record<string, Thread>;
  /** Findings keyed by thread id. */
  findings: Record<string, ReviewFinding[]>;
  /**
   * Last-seen digests for watch loops (§5D), keyed by watcher thread id then by
   * observation key. Lets a watcher notify only on deltas across heartbeats.
   */
  watch: Record<string, Record<string, string>>;
  updatedAt: number;
}
