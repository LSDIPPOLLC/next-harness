// Harness configuration and the guard limits from §9.
// Defaults are conservative: nothing runs unbounded.

export interface GuardLimits {
  /** Hard ceiling on output tokens per loop. Halt + report on breach. (§9) */
  maxTokens: number;
  /** Max agent turns a single heartbeat wake may drive, so one wake can't spiral. (§9) */
  maxWorkPerHeartbeat: number;
  /** Absolute wall-clock bound for the whole loop, in ms. (§9) */
  maxWallClockMs: number;
  /** If the same area is re-edited this many times without converging, halt + escalate. (§9) */
  divergenceThreshold: number;
}

export interface HarnessConfig {
  /** Where state, worktrees, and logs live. */
  stateDir: string;
  /** Base for created worktrees. */
  worktreeRoot: string;
  /** Heartbeat interval in ms. Spec default 5–10 min. (§5, §6) */
  heartbeatMs: number;
  guards: GuardLimits;
  /** Repo the harness operates on (path to the main checkout). */
  repoPath: string;
}

export const DEFAULT_GUARDS: GuardLimits = {
  maxTokens: 1_500_000,
  maxWorkPerHeartbeat: 4,
  maxWallClockMs: 4 * 60 * 60 * 1000, // 4h
  divergenceThreshold: 4,
};

export function defaultConfig(repoPath: string): HarnessConfig {
  const stateDir = `${repoPath}/.harness`;
  return {
    stateDir,
    worktreeRoot: `${stateDir}/worktrees`,
    heartbeatMs: 7 * 60 * 1000, // 7 min, inside the 5–10 min band
    guards: { ...DEFAULT_GUARDS },
    repoPath,
  };
}
