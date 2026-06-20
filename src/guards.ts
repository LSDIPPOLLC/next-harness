// §9 Cost & Safety Controls.
// Every loop runs its decisions through a Guard before doing expensive work.
// The cautionary case in the spec — a 10-minute review triggering an 8h /
// 3M-token run to address three comments — is exactly what this prevents.

import type { GuardLimits } from "./config.ts";
import type { BudgetState } from "./types.ts";

export type TripReason =
  | "tokens"
  | "wallclock"
  | "iterations"
  | "divergence"
  | "killed";

export interface GuardVerdict {
  /** May the loop keep working this heartbeat? */
  ok: boolean;
  reason: TripReason | null;
  detail: string;
}

const OK: GuardVerdict = { ok: true, reason: null, detail: "" };

export class Guard {
  private readonly limits: GuardLimits;
  private killed = false;

  constructor(limits: GuardLimits) {
    this.limits = limits;
  }

  /** Operator kill-switch (§9). Worktree isolation makes the kill clean. */
  kill(): void {
    this.killed = true;
  }

  /**
   * Checked at the top of each heartbeat wake. `now` is injected so the
   * scheduler and tests share a clock.
   */
  checkBudget(budget: BudgetState, now: number): GuardVerdict {
    if (this.killed) {
      return { ok: false, reason: "killed", detail: "operator kill-switch" };
    }
    if (budget.tokensUsed >= this.limits.maxTokens) {
      return {
        ok: false,
        reason: "tokens",
        detail: `tokensUsed ${budget.tokensUsed} >= maxTokens ${this.limits.maxTokens}`,
      };
    }
    const elapsed = now - budget.startedAt;
    if (elapsed >= this.limits.maxWallClockMs) {
      return {
        ok: false,
        reason: "wallclock",
        detail: `elapsed ${elapsed}ms >= maxWallClockMs ${this.limits.maxWallClockMs}`,
      };
    }
    return OK;
  }

  /** Cap on agent turns within a single wake so one wake can't spiral (§9). */
  withinHeartbeatBudget(workDoneThisWake: number): boolean {
    return workDoneThisWake < this.limits.maxWorkPerHeartbeat;
  }

  /**
   * Divergence detection (§9): if the same area keeps getting re-touched
   * without the findings resolving, the loop is spinning — halt + escalate.
   * We count how many times each area appears unresolved across cycles.
   */
  detectDivergence(touchCounts: Map<string, number>): GuardVerdict {
    for (const [area, count] of touchCounts) {
      if (count >= this.limits.divergenceThreshold) {
        return {
          ok: false,
          reason: "divergence",
          detail: `area "${area}" re-edited ${count}x without converging`,
        };
      }
    }
    return OK;
  }
}
