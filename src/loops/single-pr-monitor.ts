// Rollout step 2: the Single-PR Monitor Loop.  §5A — the entry point.
// Watches one PR in its own worktree and, each heartbeat, addresses incoming
// review signal (bot, human, and its own fresh reviewer thread) until all
// approvals land or a guard trips. Safe to leave running for hours because
// the worktree isolates it (P4).

import type { HarnessConfig } from "../config.ts";
import { exec } from "../exec.ts";
import { Guard } from "../guards.ts";
import { heartbeat, type HeartbeatHandle, type WakeResult } from "../heartbeat.ts";
import type { Logger } from "../log.ts";
import type { StateStore } from "../state-store.ts";
import type { GitHubAdapter, PrComment } from "../adapters/github.ts";
import type { ThreadRunner } from "../adapters/thread-runner.ts";
import { spawnReviewer } from "./self-review.ts";
import type { ReviewFinding, Thread } from "../types.ts";

export interface MonitorDeps {
  gh: GitHubAdapter;
  runner: ThreadRunner;
  guard: Guard;
  store: StateStore;
  config: HarnessConfig;
  log: Logger;
  /**
   * Reads the current HEAD sha of a worktree. Injectable so the commit-landed
   * verification (§8) can be exercised without a real git checkout. Defaults to
   * `git rev-parse HEAD`.
   */
  readHead?: (cwd: string) => Promise<string | null>;
}

export interface MonitorParams {
  threadId: string;
  prNumber: number;
  worktreePath: string;
  baseBranch: string;
  /** Merge automatically once mergeable, vs. stopping for operator merge (§5A, §8). */
  autoMerge: boolean;
}

export class SinglePrMonitor {
  private readonly d: MonitorDeps;
  private readonly p: MonitorParams;
  private readonly log: Logger;
  /** Area -> times we've attempted a fix there; feeds divergence detection (§9). */
  private readonly touchCounts = new Map<string, number>();
  /** Hydrate persisted touchCounts once, on the first tick. */
  private hydrated = false;

  constructor(deps: MonitorDeps, params: MonitorParams) {
    this.d = deps;
    this.p = params;
    this.log = deps.log.child(`monitor#${params.prNumber}`);
  }

  start(): HeartbeatHandle {
    this.log.info("starting single-PR monitor", {
      pr: this.p.prNumber,
      worktree: this.p.worktreePath,
      autoMerge: this.p.autoMerge,
    });
    return heartbeat(this.d.config.heartbeatMs, () => this.tick(), this.log);
  }

  /** One heartbeat wake. Exposed for tests. */
  async tick(): Promise<WakeResult> {
    const thread = this.requireThread();
    this.hydrate(thread);

    // 1. Guards first (§9): cross-process kill-switch, then tokens / wall-clock.
    if (thread.killRequested) {
      this.d.guard.kill();
    }
    const verdict = this.d.guard.checkBudget(thread.budget, Date.now());
    if (!verdict.ok) {
      await this.halt(verdict.reason ?? "killed", verdict.detail);
      return "done";
    }

    // 2. Read PR state into §7 shape.
    const pr = await this.d.gh.getPr(this.p.prNumber);
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) t.pr = pr;
    });

    // 3. New SHA head -> spawn a FRESH reviewer thread (§5B heartbeat routine,
    //    §7 key transition). Only once per head, to avoid re-reviewing.
    if (thread.lastReviewedSha !== pr.headSha) {
      const { findings, tokensUsed } = await spawnReviewer(
        this.d.runner,
        {
          cwd: this.p.worktreePath,
          baseBranch: this.p.baseBranch,
          headSha: pr.headSha,
        },
        this.log,
      );
      await this.d.store.update((s) => {
        const t = s.threads[this.p.threadId];
        if (t) {
          t.lastReviewedSha = pr.headSha;
          t.budget.tokensUsed += tokensUsed;
        }
        s.findings[this.p.threadId] = mergeFindings(
          s.findings[this.p.threadId] ?? [],
          findings,
          resolvedIdSet(t),
        );
      });
    }

    // 4. Pull bot + human comments and fold them into findings (§4 rung 5).
    const comments = await this.d.gh.fetchComments(this.p.prNumber);
    await this.d.store.update((s) => {
      s.findings[this.p.threadId] = mergeFindings(
        s.findings[this.p.threadId] ?? [],
        comments.map(commentToFinding),
        resolvedIdSet(s.threads[this.p.threadId]),
      );
    });

    // 5. Address findings, capped per wake so one tick can't spiral. The array
    //    only ever holds open items (resolved ones are compacted out below).
    const unresolved = this.d.store.getFindings(this.p.threadId);

    let worked = 0;
    const addressed: Array<{ finding: ReviewFinding; sha: string }> = [];
    for (const finding of unresolved) {
      if (!this.d.guard.withinHeartbeatBudget(worked)) {
        this.log.info("hit per-heartbeat work cap; deferring rest", {
          remaining: unresolved.length - worked,
        });
        break;
      }
      this.touchCounts.set(
        finding.area,
        (this.touchCounts.get(finding.area) ?? 0) + 1,
      );
      const div = this.d.guard.detectDivergence(this.touchCounts);
      if (!div.ok) {
        await this.halt(div.reason ?? "divergence", div.detail);
        return "done";
      }
      const { resolved, sha } = await this.addressFinding(finding);
      if (resolved && sha) {
        worked++;
        addressed.push({ finding, sha });
      }
    }
    await this.persistTouchCounts();

    // Close the loop on the PR itself: reply once with what we fixed and
    // resolve each inline review thread, clearing the "require conversation
    // resolution" merge gate. Best-effort — a comment/resolve hiccup must not
    // fail the tick or undo the verified fixes.
    await this.acknowledgeResolved(addressed);

    // 6. Decide: done if mergeable and nothing left to fix.
    const stillOpen = this.d.store.getFindings(this.p.threadId).length > 0;
    const fresh = await this.d.gh.getPr(this.p.prNumber);

    if (fresh.mergeable && !stillOpen) {
      if (this.p.autoMerge) {
        await this.d.gh.merge(this.p.prNumber);
        await this.setStatus("merged");
      } else {
        this.log.info("PR approved and clean — awaiting operator merge (§8)");
        await this.setStatus("approved");
      }
      return "done";
    }

    await this.setStatus(stillOpen ? "fixing" : "awaiting_review");
    return "continue";
  }

  /**
   * Spawn a worker thread to implement one fix, then push. Returns whether the
   * fix was verified to land (a commit advanced HEAD) and the new sha.
   */
  private async addressFinding(
    finding: ReviewFinding,
  ): Promise<{ resolved: boolean; sha: string | null }> {
    const seed = `A reviewer raised this on the current PR.

Area: ${finding.area}
Comment: ${finding.body}

Make the smallest correct change that resolves it. Then:
- commit with a clear message
- run: git push
Do not address anything outside this comment.`;

    const before = await this.worktreeHead();
    const result = await this.d.runner.run(seed, {
      cwd: this.p.worktreePath,
      label: `fix:${finding.area}`,
    });
    const after = await this.worktreeHead();

    // "Look late" verification (§8): trust, but confirm. A worker can report
    // success without actually committing (e.g. a failed `git commit`). Only
    // treat a finding as resolved if the branch head genuinely advanced —
    // otherwise it stays open, re-touches, and trips divergence (§9) instead
    // of being silently masked.
    const committed = after !== null && after !== before;
    const resolved = result.ok && committed;

    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) t.budget.tokensUsed += result.tokensUsed;
      if (resolved && t) {
        // Compaction: drop the resolved finding from the array but remember its
        // id, so a re-fetched bot comment isn't resurrected.
        s.findings[this.p.threadId] = (s.findings[this.p.threadId] ?? []).filter(
          (f) => f.id !== finding.id,
        );
        const ids = t.loopState?.resolvedFindingIds ?? [];
        if (!ids.includes(finding.id)) {
          t.loopState = { ...t.loopState, resolvedFindingIds: [...ids, finding.id] };
        }
      }
    });

    if (resolved) {
      this.log.info("addressed finding", { area: finding.area, head: after?.slice(0, 7) });
    } else if (result.ok && !committed) {
      this.log.warn("worker reported success but produced no commit — leaving open", {
        area: finding.area,
      });
    } else {
      this.log.warn("worker failed to address finding", {
        area: finding.area,
        text: result.text.slice(0, 160),
      });
    }
    return { resolved, sha: resolved ? after : null };
  }

  /**
   * After a tick's fixes land, acknowledge them on the PR: resolve each inline
   * review thread we addressed, then post a single summary comment. All
   * best-effort — the fixes are already committed and tracked, so a failure
   * here only loses the courtesy reply, never correctness.
   */
  private async acknowledgeResolved(
    addressed: Array<{ finding: ReviewFinding; sha: string }>,
  ): Promise<void> {
    if (addressed.length === 0) return;

    for (const { finding, sha } of addressed) {
      if (!finding.threadId) continue;
      try {
        await this.d.gh.resolveReviewThread(finding.threadId);
      } catch (err) {
        this.log.warn("could not resolve review thread (continuing)", {
          area: finding.area,
          detail: err instanceof Error ? err.message : String(err),
          head: sha.slice(0, 7),
        });
      }
    }

    const lines = addressed.map(({ finding, sha }) => `- ${finding.area} — ${sha.slice(0, 7)}`);
    const body =
      `🤖 next-harness addressed ${addressed.length} review finding(s):\n\n` +
      `${lines.join("\n")}\n\n_Verified each fix advanced the branch head._`;
    try {
      await this.d.gh.postComment(this.p.prNumber, body);
    } catch (err) {
      this.log.warn("could not post acknowledgment comment (continuing)", {
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Current HEAD sha of the worktree, or null if it can't be read. */
  private async worktreeHead(): Promise<string | null> {
    if (this.d.readHead) return this.d.readHead(this.p.worktreePath);
    const { stdout, code } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: this.p.worktreePath,
      rejectOnError: false,
    });
    return code === 0 ? stdout.trim() : null;
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
      if (t) {
        t.status = status;
        t.budget.iterations += 1;
      }
    });
  }

  /** Load persisted divergence counters once, so a restart resumes them. */
  private hydrate(thread: Thread): void {
    if (this.hydrated) return;
    for (const [area, count] of Object.entries(thread.loopState?.touchCounts ?? {})) {
      this.touchCounts.set(area, count);
    }
    this.hydrated = true;
  }

  private async persistTouchCounts(): Promise<void> {
    const snapshot = Object.fromEntries(this.touchCounts);
    await this.d.store.update((s) => {
      const t = s.threads[this.p.threadId];
      if (t) t.loopState = { ...t.loopState, touchCounts: snapshot };
    });
  }

  private requireThread(): Thread {
    const t = this.d.store.getThread(this.p.threadId);
    if (!t) throw new Error(`thread ${this.p.threadId} not found in state`);
    return t;
  }
}

function resolvedIdSet(thread: Thread | undefined): ReadonlySet<string> {
  return new Set(thread?.loopState?.resolvedFindingIds ?? []);
}

function commentToFinding(c: PrComment): ReviewFinding {
  return {
    id: c.id,
    source: c.isBot ? "review-bot" : "human",
    area: c.area,
    body: `[@${c.author}] ${c.body}`,
    threadId: c.threadId,
  };
}

/**
 * Union by id, skipping anything already resolved. `resolvedIds` lets us drop
 * resolved findings from the array (compaction) without resurrecting them when
 * the same bot comment is fetched again next heartbeat.
 */
function mergeFindings(
  existing: ReviewFinding[],
  incoming: ReviewFinding[],
  resolvedIds: ReadonlySet<string>,
): ReviewFinding[] {
  const byId = new Map(existing.map((f) => [f.id, f]));
  for (const f of incoming) {
    if (!byId.has(f.id) && !resolvedIds.has(f.id)) byId.set(f.id, f);
  }
  return [...byId.values()];
}
