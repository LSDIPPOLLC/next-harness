// §6 Workflow Generation Contract.
// When the orchestrator (or, for now, the operator) defines a multi-piece
// workflow, it produces a WorkflowDefinition. The operator approves the
// *definition* — which replaces approving each step (§8). Step 5 (§5B) will
// have the orchestrator generate these; this module is the contract + the
// deterministic validation/ordering they share.

import type { GuardLimits } from "./config.ts";

/** One unit of work — typically one PR — within a larger workflow. */
export interface Piece {
  /** Stable id, referenced by dependencies. */
  id: string;
  /** What this piece ships, in plain language. */
  scope: string;
  /** Worktree name this piece runs in (P4). */
  worktreeName: string;
  /**
   * Ids of prerequisite pieces. In the default `merge-pull-next` mode they must
   * merge before this piece starts; in `stack-on-parent` mode this piece
   * branches off its single prerequisite's PR branch (a linear stack). Empty =
   * parallelizable / stack root. (§5B)
   */
  dependsOn: string[];
  /** Path to the rendered HTML plan, filled in when plans are written. */
  planRef?: string;
}

/** The full §6 contract the operator reviews before any loop runs. */
export interface WorkflowDefinition {
  /** End state in plain language. */
  goal: string;
  pieces: Piece[];
  /** Heartbeat interval for the per-piece loops, ms. (§6) */
  heartbeatMs: number;
  /** Token / iteration / wall-clock caps applied to each piece's loop. (§6, §9) */
  budget: GuardLimits;
  /** Per-piece loop is fixed for the MVP: review on new SHA, exit on all approvals. */
  reviewTrigger: "new-sha";
  exitCondition: "all-approvals";
  /**
   * How dependents advance:
   * - `merge-pull-next` (default): each piece merges to base before dependents
   *   start; dependents branch off the freshly merged base.
   * - `stack-on-parent`: dependents branch off their parent's PR branch without
   *   merging first (true stacked PRs); nothing merges during the run — the
   *   operator merges the approved stack bottom-up afterwards. Requires a linear
   *   chain (≤1 dependency per piece).
   */
  advanceRule: "merge-pull-next" | "stack-on-parent";
}

export interface ValidationError {
  pieceId: string | null;
  message: string;
}

/**
 * Validate a definition and return the topological execution order.
 * Surfaces every structural problem the operator should see before approving:
 * duplicate ids, dangling/self dependencies, and dependency cycles.
 */
export function planOrder(def: WorkflowDefinition): {
  ok: boolean;
  order: string[];
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];
  const ids = new Set<string>();
  for (const p of def.pieces) {
    if (ids.has(p.id)) {
      errors.push({ pieceId: p.id, message: `duplicate piece id "${p.id}"` });
    }
    ids.add(p.id);
  }

  for (const p of def.pieces) {
    for (const dep of p.dependsOn) {
      if (dep === p.id) {
        errors.push({ pieceId: p.id, message: `piece "${p.id}" depends on itself` });
      } else if (!ids.has(dep)) {
        errors.push({
          pieceId: p.id,
          message: `piece "${p.id}" depends on unknown piece "${dep}"`,
        });
      }
    }
  }

  // Stacked mode is a linear chain: a piece can branch off at most one parent.
  if (def.advanceRule === "stack-on-parent") {
    for (const p of def.pieces) {
      if (p.dependsOn.length > 1) {
        errors.push({
          pieceId: p.id,
          message: `stacked mode requires a linear chain, but "${p.id}" depends on ${p.dependsOn.length} pieces`,
        });
      }
    }
  }

  // Kahn's algorithm for topological order + cycle detection.
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const p of def.pieces) {
    indeg.set(p.id, 0);
    dependents.set(p.id, []);
  }
  for (const p of def.pieces) {
    for (const dep of p.dependsOn) {
      if (!ids.has(dep) || dep === p.id) continue; // already reported
      indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
      dependents.get(dep)!.push(p.id);
    }
  }

  // Deterministic: process ready pieces in declared order.
  const declaredIndex = new Map(def.pieces.map((p, i) => [p.id, i]));
  const ready = def.pieces
    .filter((p) => (indeg.get(p.id) ?? 0) === 0)
    .map((p) => p.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (declaredIndex.get(a)! - declaredIndex.get(b)!));
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) ready.push(next);
    }
  }

  if (order.length !== def.pieces.length) {
    const stuck = def.pieces.map((p) => p.id).filter((id) => !order.includes(id));
    errors.push({
      pieceId: null,
      message: `dependency cycle among: ${stuck.join(", ")}`,
    });
  }

  return { ok: errors.length === 0, order, errors };
}

/**
 * Group the topological order into "waves" — each wave is a set of pieces with
 * no remaining interdependencies, i.e. safe to run in parallel (§5B: stack
 * mostly, parallelize where safe).
 */
export function planWaves(def: WorkflowDefinition, order: string[]): string[][] {
  const byId = new Map(def.pieces.map((p) => [p.id, p]));
  const waveOf = new Map<string, number>();
  for (const id of order) {
    const p = byId.get(id);
    const deps = p?.dependsOn ?? [];
    const w = deps.reduce((max, d) => Math.max(max, (waveOf.get(d) ?? -1) + 1), 0);
    waveOf.set(id, w);
  }
  const waves: string[][] = [];
  for (const id of order) {
    const w = waveOf.get(id) ?? 0;
    (waves[w] ??= []).push(id);
  }
  return waves;
}
