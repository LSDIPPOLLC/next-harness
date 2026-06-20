// Rollout step 3: self-review chaining.  §4 rung 6, §5B reviewer thread, P5.
// The worker invokes a *fresh* reviewer thread (spawn_thread) to read the
// diff and produce actionable findings before any human looks ("look late").
// A fresh thread per new SHA head is the core §7 transition.

import { randomUUID } from "node:crypto";
import type { Logger } from "../log.ts";
import type { ThreadRunner } from "../adapters/thread-runner.ts";
import { extractJson } from "../parse-json.ts";
import type { ReviewFinding } from "../types.ts";

const REVIEW_SEED = (base: string) => `You are a code reviewer. A change is on the current branch.

1. Run: git diff ${base}...HEAD
2. Review the diff for correctness bugs, missing error handling, and obvious
   quality problems. Be specific and actionable. Do not nitpick style.
3. Output ONLY a JSON array (no prose, no code fences) of findings, each:
   {"area": "<file>:<line> or short topic", "body": "<what is wrong and the fix>"}
   If there are no actionable issues, output exactly: []`;

export interface ReviewerOptions {
  cwd: string;
  baseBranch: string;
  /** Sha being reviewed, recorded on each finding's provenance. */
  headSha: string;
  timeoutMs?: number;
}

/**
 * Spawn a reviewer thread and parse its findings. Returns [] on a clean
 * review or if the reviewer produced unparseable output (logged).
 */
export async function spawnReviewer(
  runner: ThreadRunner,
  opts: ReviewerOptions,
  log: Logger,
): Promise<{ findings: ReviewFinding[]; tokensUsed: number }> {
  const rlog = log.child("reviewer");
  const result = await runner.run(REVIEW_SEED(opts.baseBranch), {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    label: `review@${opts.headSha.slice(0, 7)}`,
  });

  if (!result.ok) {
    rlog.warn("reviewer run failed", { text: result.text.slice(0, 200) });
    return { findings: [], tokensUsed: result.tokensUsed };
  }

  const parsed = parseFindings(result.text);
  if (parsed === null) {
    rlog.warn("could not parse reviewer output as findings JSON");
    return { findings: [], tokensUsed: result.tokensUsed };
  }

  const findings: ReviewFinding[] = parsed.map((p) => ({
    id: `reviewer:${randomUUID()}`,
    source: "reviewer-thread",
    area: p.area || "general",
    body: p.body,
  }));
  rlog.info(`reviewer produced ${findings.length} finding(s)`, {
    sha: opts.headSha.slice(0, 7),
  });
  return { findings, tokensUsed: result.tokensUsed };
}

function parseFindings(text: string): Array<{ area: string; body: string }> | null {
  // Tolerate the model wrapping the array in fences or surrounding prose.
  const arr = extractJson(text, "array");
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(
      (x): x is { area?: unknown; body?: unknown } =>
        typeof x === "object" && x !== null,
    )
    .map((x) => ({
      area: typeof x.area === "string" ? x.area : "general",
      body: typeof x.body === "string" ? x.body : JSON.stringify(x),
    }));
}
