// Durable, atomic store for HarnessState so loops survive process restarts.
// One JSON file under the state dir; writes go through a temp file + rename.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  HarnessState,
  ReviewFinding,
  Thread,
} from "./types.ts";

export class StateStore {
  readonly path: string;
  private state: HarnessState;
  /** Tail of the write queue; serializes concurrent updates (§5B waves). */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(path: string, state: HarnessState) {
    this.path = path;
    this.state = state;
  }

  static async open(stateDir: string): Promise<StateStore> {
    // Guarantee the state dir exists so any command that opens the store can
    // safely write sibling files (plans, plan.json) without an ENOENT race.
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, "state.json");
    let state: HarnessState;
    try {
      const raw = await readFile(path, "utf8");
      state = JSON.parse(raw) as HarnessState;
      // Backfill fields added after a state file was first written.
      state.watch ??= {};
    } catch {
      state = { threads: {}, findings: {}, watch: {}, updatedAt: Date.now() };
    }
    return new StateStore(path, state);
  }

  snapshot(): HarnessState {
    return structuredClone(this.state);
  }

  getThread(id: string): Thread | undefined {
    return this.state.threads[id];
  }

  listThreads(): Thread[] {
    return Object.values(this.state.threads);
  }

  getFindings(threadId: string): ReviewFinding[] {
    return this.state.findings[threadId] ?? [];
  }

  /** Last-seen digests for a watch loop (§5D). */
  getWatch(threadId: string): Record<string, string> {
    return this.state.watch[threadId] ?? {};
  }

  /**
   * Apply a mutation and persist atomically. Concurrent calls (e.g. parallel
   * pieces in a §5B wave) are serialized through a write queue so the mutate
   * bodies don't interleave and the temp-file rename can't race.
   */
  async update(mutate: (s: HarnessState) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      mutate(this.state);
      this.state.updatedAt = Date.now();
      await this.flush();
    });
    // Keep the chain alive even if this update throws, so a failed write
    // doesn't wedge every subsequent update.
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Unique temp per write: defense in depth against any cross-process writer.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
