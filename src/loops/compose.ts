// Goal -> WorkflowDefinition generation.  §5B setup, P1/P2 — "loops create
// loops". Instead of the operator hand-writing a plan, an agent thread inspects
// the repo and decomposes a goal into ordered pieces. The result is validated
// with planOrder; the operator approves the *definition* (§8) before `run`.
//
// The agent only decides the decomposition (pieces + dependencies). The fixed
// contract fields (review trigger, exit/advance rules) and budgets are filled
// in here so the generated definition is always well-formed and policy-bound.

import type { GuardLimits } from "../config.ts";
import type { Logger } from "../log.ts";
import type { ThreadRunner } from "../adapters/thread-runner.ts";
import { extractJson } from "../parse-json.ts";
import { planOrder, type Piece, type WorkflowDefinition } from "../plan.ts";

export interface ComposeParams {
  goal: string;
  /** Repo to inspect while decomposing (run cwd). */
  cwd: string;
  heartbeatMs: number;
  budget: GuardLimits;
  timeoutMs?: number;
}

export interface ComposeResult {
  ok: boolean;
  def: WorkflowDefinition;
  order: string[];
  errors: string[];
  /** Raw generator text, kept for debugging a bad generation. */
  raw: string;
}

const seedFor = (goal: string) => `You are planning how to ship a goal as a series of pull requests.

Goal: ${goal}

Inspect the repository as needed, then break the work into the smallest
sensible pieces that each ship as one PR. Decide ordering: a piece lists in
"dependsOn" the ids of pieces that must merge before it can start; pieces with
no dependency between them can run in parallel.

Output ONLY a JSON object (no prose, no code fences):
{
  "goal": "<restate the goal in one line>",
  "pieces": [
    {
      "id": "<kebab-case, unique>",
      "scope": "<what this PR ships, one or two sentences>",
      "worktreeName": "<kebab-case, usually equal to id>",
      "dependsOn": ["<id of a prerequisite piece>", "..."]
    }
  ]
}

Rules: ids are unique and kebab-case; list prerequisites before dependents;
keep pieces small enough to review as one PR; do not invent unrelated work.`;

/**
 * Generate and validate a WorkflowDefinition for a goal. Always returns a
 * definition (possibly empty/invalid) plus the validation errors, so the
 * caller can show the operator what to fix rather than crashing.
 */
export async function composeWorkflow(
  runner: ThreadRunner,
  params: ComposeParams,
  log: Logger,
): Promise<ComposeResult> {
  const clog = log.child("compose");
  const result = await runner.run(seedFor(params.goal), {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    label: "compose",
  });

  const def = emptyDef(params);
  if (!result.ok) {
    return {
      ok: false,
      def,
      order: [],
      errors: [`generator run failed: ${result.text.slice(0, 200)}`],
      raw: result.text,
    };
  }

  const raw = extractJson(result.text, "object");
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      def,
      order: [],
      errors: ["generator did not emit a JSON object"],
      raw: result.text,
    };
  }

  const built = coerce(raw as Record<string, unknown>, params);
  const { ok, order, errors } = planOrder(built);
  clog.info(`generated ${built.pieces.length} piece(s)`, {
    goal: built.goal,
    ok,
  });
  return {
    ok: ok && built.pieces.length > 0,
    def: built,
    order,
    errors: built.pieces.length === 0
      ? ["generator produced no usable pieces", ...errors.map((e) => e.message)]
      : errors.map((e) => e.message),
    raw: result.text,
  };
}

function coerce(raw: Record<string, unknown>, params: ComposeParams): WorkflowDefinition {
  const rawPieces = Array.isArray(raw.pieces) ? raw.pieces : [];
  const pieces: Piece[] = [];
  for (const entry of rawPieces) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "") continue;
    const id = e.id.trim();
    pieces.push({
      id,
      scope: typeof e.scope === "string" ? e.scope : "",
      worktreeName:
        typeof e.worktreeName === "string" && e.worktreeName.trim() !== ""
          ? e.worktreeName.trim()
          : id,
      dependsOn: Array.isArray(e.dependsOn)
        ? e.dependsOn.filter((d): d is string => typeof d === "string")
        : [],
    });
  }
  return {
    goal: typeof raw.goal === "string" && raw.goal.trim() !== "" ? raw.goal : params.goal,
    pieces,
    heartbeatMs: params.heartbeatMs,
    budget: params.budget,
    reviewTrigger: "new-sha",
    exitCondition: "all-approvals",
    advanceRule: "merge-pull-next",
  };
}

function emptyDef(params: ComposeParams): WorkflowDefinition {
  return {
    goal: params.goal,
    pieces: [],
    heartbeatMs: params.heartbeatMs,
    budget: params.budget,
    reviewTrigger: "new-sha",
    exitCondition: "all-approvals",
    advanceRule: "merge-pull-next",
  };
}
