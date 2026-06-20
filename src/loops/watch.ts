// Rollout step 7b: watch / context loops.  §5D.
// Loops that *bring information to you* rather than fetch on demand: heartbeat
// + a condition + a notification sink. The loop diffs each observation against
// the last-seen digest in state and notifies only on deltas, so a long-running
// watcher is quiet until something actually changes.
//
// The Observer is injected, so the same loop watches PRs, issues, deploys, or
// anything else — the concrete prListObserver below is one instance.

import type { HarnessConfig } from "../config.ts";
import { Guard } from "../guards.ts";
import { heartbeat, type HeartbeatHandle, type WakeResult } from "../heartbeat.ts";
import type { Logger } from "../log.ts";
import type { StateStore } from "../state-store.ts";
import type { Notifier } from "../adapters/notifier.ts";
import type { GitHubAdapter } from "../adapters/github.ts";
import type { Thread } from "../types.ts";

/** One thing being watched: a stable key, a change digest, and a label. */
export interface Observation {
  key: string;
  digest: string;
  summary: string;
}

export type Observer = () => Promise<Observation[]>;

export interface WatchDeps {
  observer: Observer;
  notifier: Notifier;
  guard: Guard;
  store: StateStore;
  config: HarnessConfig;
  log: Logger;
}

export interface WatchParams {
  threadId: string;
  /** Human label used in notifications. */
  name: string;
}

interface Delta {
  added: Observation[];
  changed: Observation[];
  removed: string[];
}

export class WatchLoop {
  private readonly d: WatchDeps;
  private readonly p: WatchParams;
  private readonly log: Logger;

  constructor(deps: WatchDeps, params: WatchParams) {
    this.d = deps;
    this.p = params;
    this.log = deps.log.child(`watch:${params.name}`);
  }

  start(): HeartbeatHandle {
    this.log.info("starting watch loop", { name: this.p.name });
    return heartbeat(this.d.config.heartbeatMs, () => this.tick(), this.log);
  }

  /** One observation cycle. Exposed for tests. Returns "continue" forever. */
  async tick(): Promise<WakeResult> {
    const thread = this.requireThread();
    if (thread.killRequested) this.d.guard.kill();
    const verdict = this.d.guard.checkBudget(thread.budget, Date.now());
    if (!verdict.ok) {
      this.log.warn("watch loop stopping", { reason: verdict.reason, detail: verdict.detail });
      await this.setStatus(verdict.reason === "killed" ? "done" : "halted");
      return "done";
    }

    const observations = await this.d.observer();
    const last = this.d.store.getWatch(this.p.threadId);
    const delta = diff(observations, last);

    if (delta.added.length || delta.changed.length || delta.removed.length) {
      await this.d.notifier.notify(render(this.p.name, delta));
    } else {
      this.log.debug("no change");
    }

    // Persist the new snapshot and bump the iteration counter.
    const next: Record<string, string> = {};
    for (const o of observations) next[o.key] = o.digest;
    await this.d.store.update((s) => {
      s.watch[this.p.threadId] = next;
      const t = s.threads[this.p.threadId];
      if (t) t.budget.iterations += 1;
    });

    return "continue";
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

/** Concrete observer: watch every open PR in the repo (§5D example). */
export function prListObserver(gh: GitHubAdapter): Observer {
  return async () => {
    const prs = await gh.listOpenPrs();
    return prs.map((p) => ({
      key: `pr-${p.number}`,
      digest: `${p.headSha}|${p.reviewDecision ?? "-"}|${p.updatedAt}`,
      summary: `#${p.number} ${p.title} [${p.reviewDecision ?? "no decision"}]`,
    }));
  };
}

function diff(observations: Observation[], last: Record<string, string>): Delta {
  const added: Observation[] = [];
  const changed: Observation[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    seen.add(o.key);
    const prev = last[o.key];
    if (prev === undefined) added.push(o);
    else if (prev !== o.digest) changed.push(o);
  }
  const removed = Object.keys(last).filter((k) => !seen.has(k));
  return { added, changed, removed };
}

function render(name: string, delta: Delta): string {
  const parts: string[] = [`[watch:${name}]`];
  if (delta.added.length) {
    parts.push("New:", ...delta.added.map((o) => `  + ${o.summary}`));
  }
  if (delta.changed.length) {
    parts.push("Updated:", ...delta.changed.map((o) => `  ~ ${o.summary}`));
  }
  if (delta.removed.length) {
    parts.push("Gone:", ...delta.removed.map((k) => `  - ${k}`));
  }
  return parts.join("\n");
}
