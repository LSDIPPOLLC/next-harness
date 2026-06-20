// Rollout step 5: the Dynamic Stacked-PR Meta-Workflow.  §5B — the payoff.
// The orchestrator owns the goal and derives the work: it walks the validated
// plan into waves, and for each piece spawns a worker → files a PR → runs a
// SinglePrMonitor sub-loop (the loop creates sub-loops, P3) → on approval
// merges, then advances. Pieces in a wave run concurrently; waves are a
// barrier (§5B: "stack mostly, parallelize where safe").
//
// "Pull latest main, create the next worktree" is realized by each new
// worktree branching off the freshly fetched origin/<base> (see WorktreeManager).

import { Guard } from "../guards.ts";
import type { HarnessConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { StateStore } from "../state-store.ts";
import type { GitHubAdapter } from "../adapters/github.ts";
import type { ThreadRunner } from "../adapters/thread-runner.ts";
import type { WorktreeManager } from "../adapters/worktree.ts";
import {
  planOrder,
  planWaves,
  type Piece,
  type WorkflowDefinition,
} from "../plan.ts";
import { SinglePrMonitor } from "./single-pr-monitor.ts";
import { retry } from "../retry.ts";
import type { Thread } from "../types.ts";

export interface OrchestratorDeps {
  gh: GitHubAdapter;
  runner: ThreadRunner;
  worktrees: WorktreeManager;
  store: StateStore;
  config: HarnessConfig;
  log: Logger;
}

export interface OrchestratorOptions {
  baseBranch: string;
  /**
   * How to run a piece's review sub-loop to completion. Default heartbeat-paces
   * via monitor.start(); tests inject a fast tick-driver.
   */
  driveMonitor?: (m: SinglePrMonitor) => Promise<void>;
  /** Attempts for the transient steps (implement, file PR) before abandon. */
  retries?: number;
  /** Injectable sleep for retry backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface PieceOutcome {
  pieceId: string;
  prNumber: number | null;
  status: Thread["status"];
}

export class StackedPrOrchestrator {
  private readonly d: OrchestratorDeps;
  private readonly def: WorkflowDefinition;
  private readonly log: Logger;

  constructor(deps: OrchestratorDeps, def: WorkflowDefinition) {
    this.d = deps;
    this.def = def;
    this.log = deps.log.child("orchestrator");
  }

  async run(opts: OrchestratorOptions): Promise<PieceOutcome[]> {
    const { ok, order, errors } = planOrder(this.def);
    if (!ok) {
      throw new Error(
        `cannot run invalid workflow: ${errors.map((e) => e.message).join("; ")}`,
      );
    }
    const waves = planWaves(this.def, order);
    const byId = new Map(this.def.pieces.map((p) => [p.id, p]));
    const drive = opts.driveMonitor ?? ((m) => m.start().done);
    const stacked = this.def.advanceRule === "stack-on-parent";

    await this.recordOrchestratorThread();
    this.log.info("workflow start", {
      goal: this.def.goal,
      mode: this.def.advanceRule,
      waves: waves.map((w) => w.join("+")),
    });

    const outcomes: PieceOutcome[] = [];
    for (const [i, wave] of waves.entries()) {
      this.log.info(`wave ${i + 1}/${waves.length}`, { pieces: wave });
      // Barrier between waves; concurrency within a wave.
      const waveOutcomes = await Promise.all(
        wave.map((id) => this.runPiece(byId.get(id)!, opts, drive, byId)),
      );
      outcomes.push(...waveOutcomes);

      // Stop advancing if a piece didn't reach its mode's ready state, since a
      // dependent would branch off a base that lacks its prerequisite. In
      // merge mode "ready" is merged; in stacked mode the parent only needs to
      // be approved (the stack merges bottom-up later).
      const ready = (s: Thread["status"]) =>
        s === "merged" || (stacked && s === "approved");
      const stalled = waveOutcomes.filter((o) => !ready(o.status));
      if (stalled.length > 0) {
        this.log.error("wave did not fully complete — halting advance (§9)", {
          stalled: stalled.map((o) => `${o.pieceId}:${o.status}`),
        });
        break;
      }
    }

    if (stacked && outcomes.every((o) => o.status === "approved")) {
      this.log.info("stack fully approved — operator merges bottom-up (§8)", {
        order: outcomes.map((o) => `#${o.prNumber ?? "?"}`).join(" <- "),
      });
    }
    return outcomes;
  }

  private async runPiece(
    piece: Piece,
    opts: OrchestratorOptions,
    drive: (m: SinglePrMonitor) => Promise<void>,
    byId: Map<string, Piece>,
  ): Promise<PieceOutcome> {
    const plog = this.log.child(piece.id);
    const threadId = `piece-${piece.id}`;
    const stacked = this.def.advanceRule === "stack-on-parent";
    // In stacked mode a dependent branches off its parent's PR branch, not the
    // workflow base; the parent's branch is already pushed by the prior wave.
    const baseBranch = this.baseFor(piece, opts.baseBranch, byId);
    const attempts = Math.max(1, opts.retries ?? 2);
    const sleep = opts.sleep;

    // Partial resume (idempotency): a piece that already reached its mode's
    // ready state on a prior run is skipped, so re-running a workflow only
    // redoes what didn't land. Merge mode → "merged"; stacked → "approved".
    const existing = this.d.store.getThread(threadId);
    const done = existing?.status === "merged" || (stacked && existing?.status === "approved");
    if (existing && done) {
      plog.info("piece already complete — skipping (resume)", { status: existing.status });
      return { pieceId: piece.id, prNumber: existing.pr?.number ?? null, status: existing.status };
    }

    // Fresh worktree off the latest base (the "pull main" step).
    const wt = await this.d.worktrees.create(piece.worktreeName, baseBranch);
    await this.d.store.update((s) => {
      s.threads[threadId] = workerThread(threadId, piece.id, wt.path);
    });

    // 1. Implement the piece, commit, and push the branch — with bounded retry
    //    so a transient failure doesn't abandon a viable piece.
    try {
      const impl = await retry(
        async () => {
          const r = await this.d.runner.run(implementSeed(piece, wt.branch), {
            cwd: wt.path,
            label: `impl:${piece.id}`,
          });
          await this.d.store.update((s) => {
            const t = s.threads[threadId];
            if (t) t.budget.tokensUsed += r.tokensUsed;
          });
          if (!r.ok) throw new Error(`implementation turn failed: ${r.text.slice(0, 160)}`);
          return r;
        },
        { attempts, sleep, onRetry: (_e, n) => plog.warn(`impl retry ${n}/${attempts}`) },
      );
      void impl;
    } catch (err) {
      plog.error("implementation failed after retries — abandoning piece", {
        detail: err instanceof Error ? err.message : String(err),
      });
      await this.setStatus(threadId, "abandoned");
      return { pieceId: piece.id, prNumber: null, status: "abandoned" };
    }

    // 2. File the PR (also retried — `gh` can be flaky).
    let prNumber: number;
    try {
      prNumber = await retry(
        () =>
          this.d.gh.createPr(
            wt.branch,
            baseBranch,
            `${piece.id}: ${piece.scope}`.slice(0, 72),
            prBody(piece),
          ),
        { attempts, sleep, onRetry: (_e, n) => plog.warn(`createPr retry ${n}/${attempts}`) },
      );
    } catch (err) {
      plog.error("filing PR failed after retries — abandoning piece", {
        detail: err instanceof Error ? err.message : String(err),
      });
      await this.setStatus(threadId, "abandoned");
      return { pieceId: piece.id, prNumber: null, status: "abandoned" };
    }
    await this.d.store.update((s) => {
      const t = s.threads[threadId];
      if (t) {
        t.pr = { number: prNumber, headSha: "", checks: null, approvals: 0, mergeable: false };
      }
    });

    // 3. Spawn the review sub-loop (loops create loops, P3). Auto-merge so the
    //    orchestrator can advance once the piece is approved and clean.
    const pieceConfig: HarnessConfig = {
      ...this.d.config,
      heartbeatMs: this.def.heartbeatMs,
      guards: this.def.budget,
    };
    const monitor = new SinglePrMonitor(
      {
        gh: this.d.gh,
        runner: this.d.runner,
        guard: new Guard(this.def.budget),
        store: this.d.store,
        config: pieceConfig,
        log: this.d.log,
      },
      {
        threadId,
        prNumber,
        worktreePath: wt.path,
        baseBranch,
        // Stacked mode never merges mid-run; the operator merges the approved
        // stack bottom-up afterwards.
        autoMerge: !stacked,
      },
    );
    await drive(monitor);

    const status = this.d.store.getThread(threadId)?.status ?? "abandoned";
    plog.info("piece finished", { prNumber, status });
    return { pieceId: piece.id, prNumber, status };
  }

  /**
   * The branch a piece's worktree and PR sit on top of. Default mode always
   * uses the workflow base. Stacked mode bases a dependent on its single
   * parent's PR branch (`harness/<parent.worktreeName>`), forming the stack; a
   * stack root with no dependency still uses the workflow base.
   */
  private baseFor(piece: Piece, workflowBase: string, byId: Map<string, Piece>): string {
    if (this.def.advanceRule !== "stack-on-parent") return workflowBase;
    const parentId = piece.dependsOn[0];
    if (!parentId) return workflowBase;
    const parent = byId.get(parentId);
    return parent ? `harness/${parent.worktreeName}` : workflowBase;
  }

  private async recordOrchestratorThread(): Promise<void> {
    await this.d.store.update((s) => {
      s.threads["orchestrator"] ??= {
        id: "orchestrator",
        role: "orchestrator",
        worktree: null,
        pieceId: null,
        pr: null,
        status: "planning",
        lastReviewedSha: null,
        killRequested: false,
        budget: { tokensUsed: 0, iterations: 0, startedAt: Date.now() },
        notes: [this.def.goal],
      };
    });
  }

  private async setStatus(threadId: string, status: Thread["status"]): Promise<void> {
    await this.d.store.update((s) => {
      const t = s.threads[threadId];
      if (t) t.status = status;
    });
  }
}

function workerThread(id: string, pieceId: string, worktree: string): Thread {
  return {
    id,
    role: "worker",
    worktree,
    pieceId,
    pr: null,
    status: "implementing",
    lastReviewedSha: null,
    killRequested: false,
    budget: { tokensUsed: 0, iterations: 0, startedAt: Date.now() },
    notes: [],
  };
}

function implementSeed(piece: Piece, branch: string): string {
  return `Implement this piece of work end to end.

Scope: ${piece.scope}

When done:
- commit with a clear message
- push the branch: git push -u origin ${branch}
Stay strictly within this scope; later pieces handle the rest.`;
}

function prBody(piece: Piece): string {
  const ref = piece.planRef ? `\n\nPlan: ${piece.planRef}` : "";
  return `Automated piece **${piece.id}** of a stacked workflow.\n\n${piece.scope}${ref}\n\n_Filed by next-harness orchestrator (§5B)._`;
}
