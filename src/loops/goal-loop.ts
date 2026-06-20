// Rollout step 7a: the linear `goal_loop` grinder.  §5C.
// One thread, one goal, no branching. Each tick the agent makes concrete
// progress and self-reports whether the goal is met; the loop repeats until
// done or a guard trips. For rewrites / migrations / exploratory builds where
// there is nothing to parallelize. Output is experimental by default (§10).
//
// Distinct from the dynamic workflow (§5B): no pieces, no PRs, no sub-loops —
// just "keep going until done", bounded by §9 guards.

import type { HarnessConfig } from "../config.ts";
import { Guard } from "../guards.ts";
import { heartbeat, type HeartbeatHandle, type WakeResult } from "../heartbeat.ts";
import type { Logger } from "../log.ts";
import type { StateStore } from "../state-store.ts";
import type { ThreadRunner } from "../adapters/thread-runner.ts";
import { extractJson } from "../parse-json.ts";
import type { Thread } from "../types.ts";

export interface GoalLoopDeps {
  runner: ThreadRunner;
  guard: Guard;
  store: StateStore;
  config: HarnessConfig;
  log: Logger;
}

export interface GoalLoopParams {
  threadId: string;
  goal: string;
  /** Isolated worktree the grinder works in (P4). */
  worktreePath: string;
}

interface Progress {
  done: boolean;
  summary: string;
  next: string;
}

export class GoalLoop {
  private readonly d: GoalLoopDeps;
  private readonly p: GoalLoopParams;
  private readonly log: Logger;
  /** Continuation note handed to the next turn ("where you left off"). */
  private lastNext = "";
  private lastSummary = "";
  /** Consecutive ticks with no fresh progress — the §9 divergence analog. */
  private noProgress = 0;
  /** Hydrate persisted loop state once, on the first tick. */
  private hydrated = false;

  constructor(deps: GoalLoopDeps, params: GoalLoopParams) {
    this.d = deps;
    this.p = params;
    this.log = deps.log.child(`grind#${params.threadId}`);
  }

  start(): HeartbeatHandle {
    this.log.info("starting goal_loop grinder", { goal: this.p.goal });
    return heartbeat(this.d.config.heartbeatMs, () => this.tick(), this.log);
  }

  /** One iteration of the grind. Exposed for tests. */
  async tick(): Promise<WakeResult> {
    const thread = this.requireThread();
    this.hydrate(thread);

    if (thread.killRequested) this.d.guard.kill();
    const verdict = this.d.guard.checkBudget(thread.budget, Date.now());
    if (!verdict.ok) {
      await this.halt(verdict.reason ?? "killed", verdict.detail);
      return "done";
    }

    const result = await this.d.runner.run(grindSeed(this.p.goal, this.lastNext), {
      cwd: this.p.worktreePath,
      label: `grind:${this.p.threadId}`,
    });
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) {
        t.budget.tokensUsed += result.tokensUsed;
        t.budget.iterations += 1;
      }
    });

    if (!result.ok) {
      this.log.warn("grind turn failed", { text: result.text.slice(0, 160) });
      if (this.registerNoProgress("(turn failed)")) {
        await this.halt("divergence", "repeated failing turns without progress");
        return "done";
      }
      await this.persist();
      await this.setStatus("implementing");
      return "continue";
    }

    const progress = parseProgress(result.text);
    await this.appendNote(progress);
    this.lastNext = progress.next;

    if (progress.done) {
      this.log.info("goal reported met", { iterations: thread.budget.iterations + 1 });
      await this.setStatus("done");
      return "done";
    }

    if (this.registerNoProgress(progress.summary)) {
      await this.halt("divergence", "no fresh progress across turns — escalating (§9)");
      return "done";
    }

    await this.persist();
    await this.setStatus("implementing");
    return "continue";
  }

  /** Load persisted continuation/streak state once, so a restart resumes it. */
  private hydrate(thread: Thread): void {
    if (this.hydrated) return;
    const ls = thread.loopState;
    this.lastNext = ls?.lastNext ?? "";
    this.lastSummary = ls?.lastSummary ?? "";
    this.noProgress = ls?.noProgress ?? 0;
    this.hydrated = true;
  }

  private async persist(): Promise<void> {
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) {
        t.loopState = {
          ...t.loopState,
          lastNext: this.lastNext,
          lastSummary: this.lastSummary,
          noProgress: this.noProgress,
        };
      }
    });
  }

  /** Returns true when the no-progress streak has hit the divergence threshold. */
  private registerNoProgress(summary: string): boolean {
    const stalled = summary.trim() === "" || summary.trim() === this.lastSummary.trim();
    this.noProgress = stalled ? this.noProgress + 1 : 0;
    this.lastSummary = summary;
    return this.noProgress >= this.d.config.guards.divergenceThreshold;
  }

  private async appendNote(p: Progress): Promise<void> {
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) t.notes.push(`iter ${t.budget.iterations}: ${p.summary || "(no summary)"}`);
    });
  }

  private async halt(reason: string, detail: string): Promise<void> {
    this.log.error("HALT — escalating to operator (§9)", { reason, detail });
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) {
        t.status = "halted";
        t.notes.push(`halted: ${reason} — ${detail}`);
      }
    });
  }

  private async setStatus(status: Thread["status"]): Promise<void> {
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) t.status = status;
    });
  }

  private requireThread(): Thread {
    const t = this.d.store.getThread(this.p.threadId);
    if (!t) throw new Error(`thread ${this.p.threadId} not found in state`);
    return t;
  }
}

function grindSeed(goal: string, lastNext: string): string {
  const resume = lastNext.trim()
    ? `\nWhere you left off last turn:\n${lastNext}\n`
    : "";
  return `You are working toward a goal in this working directory, one iteration at a time.

Goal: ${goal}
${resume}
Make as much concrete progress as you can this turn — edit files, run commands,
verify. Then output ONLY a JSON object (no prose, no code fences):
{"done": <true|false>, "summary": "<what you changed this turn>", "next": "<what remains; empty if done>"}

Set done=true only when the goal is fully met.`;
}

function parseProgress(text: string): Progress {
  const raw = extractJson(text, "object");
  if (raw === null || typeof raw !== "object") {
    return { done: false, summary: "", next: "" };
  }
  const o = raw as Record<string, unknown>;
  return {
    done: o.done === true,
    summary: typeof o.summary === "string" ? o.summary : "",
    next: typeof o.next === "string" ? o.next : "",
  };
}
