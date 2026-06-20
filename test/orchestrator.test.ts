import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { makeLogger } from "../src/log.ts";
import { defaultConfig } from "../src/config.ts";
import { DEFAULT_GUARDS } from "../src/config.ts";
import { StackedPrOrchestrator, type OrchestratorDeps } from "../src/loops/orchestrator.ts";
import type { SinglePrMonitor } from "../src/loops/single-pr-monitor.ts";
import type { WorkflowDefinition } from "../src/plan.ts";
import type { GitHubAdapter } from "../src/adapters/github.ts";
import type { ThreadRunner, RunOptions } from "../src/adapters/thread-runner.ts";
import type { WorktreeManager } from "../src/adapters/worktree.ts";
import type { PrState, ThreadResult } from "../src/types.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

// Drive a monitor to completion immediately (no heartbeat timers in tests).
const fastDrive = async (m: SinglePrMonitor) => {
  for (let i = 0; i < 20; i++) {
    if ((await m.tick()) === "done") return;
  }
  throw new Error("monitor did not converge");
};

function def(pieces: WorkflowDefinition["pieces"]): WorkflowDefinition {
  return {
    goal: "Ship it",
    heartbeatMs: 1000,
    budget: { ...DEFAULT_GUARDS, maxWorkPerHeartbeat: 5 },
    reviewTrigger: "new-sha",
    exitCondition: "all-approvals",
    advanceRule: "merge-pull-next",
    pieces,
  };
}

interface FakeGh {
  adapter: GitHubAdapter;
  createdPrs: string[];
  mergeOrder: number[];
}

function fakeGh(): FakeGh {
  const createdPrs: string[] = [];
  const mergeOrder: number[] = [];
  let next = 100;
  const branchToPr = new Map<string, number>();
  const adapter = {
    async createPr(head: string) {
      const number = ++next;
      branchToPr.set(head, number);
      createdPrs.push(head);
      return number;
    },
    async getPr(number: number): Promise<PrState> {
      // Approved + clean from the first read so the sub-loop converges fast.
      return { number, headSha: `sha-${number}`, checks: "SUCCESS", approvals: 1, mergeable: true };
    },
    async fetchComments() {
      return [];
    },
    async merge(number: number) {
      mergeOrder.push(number);
    },
  } as unknown as GitHubAdapter;
  return { adapter, createdPrs, mergeOrder };
}

function fakeRunner(opts: { implOk?: boolean } = {}): ThreadRunner {
  return {
    async run(seed: string, _o: RunOptions): Promise<ThreadResult> {
      if (seed.includes("You are a code reviewer")) {
        return { ok: true, text: "[]", tokensUsed: 10 };
      }
      // implementation worker
      return { ok: opts.implOk ?? true, text: "done", tokensUsed: 20 };
    },
  };
}

// Impl turn fails the first `failTimes` calls, then succeeds; reviewer is clean.
function flakyImplRunner(failTimes: number): ThreadRunner {
  let implCalls = 0;
  return {
    async run(seed: string): Promise<ThreadResult> {
      if (seed.includes("You are a code reviewer")) {
        return { ok: true, text: "[]", tokensUsed: 10 };
      }
      implCalls++;
      return { ok: implCalls > failTimes, text: "impl", tokensUsed: 20 };
    },
  };
}

function fakeWorktrees(created: string[]): WorktreeManager {
  return {
    async create(name: string) {
      created.push(name);
      return { branch: `harness/${name}`, path: `/tmp/wt/${name}` };
    },
  } as unknown as WorktreeManager;
}

async function deps(
  gh: GitHubAdapter,
  runner: ThreadRunner,
  worktrees: WorktreeManager,
): Promise<OrchestratorDeps> {
  const dir = await mkdtemp(join(tmpdir(), "harness-orch-"));
  const config = defaultConfig(dir);
  const store = await StateStore.open(config.stateDir);
  return { gh, runner, worktrees, store, config, log };
}

test("stacked pieces run in dependency order and all merge", async () => {
  const gh = fakeGh();
  const created: string[] = [];
  const d = await deps(gh.adapter, fakeRunner(), fakeWorktrees(created));
  const workflow = def([
    { id: "b", scope: "second", worktreeName: "b", dependsOn: ["a"] },
    { id: "a", scope: "first", worktreeName: "a", dependsOn: [] },
  ]);
  const orch = new StackedPrOrchestrator(d, workflow);

  const outcomes = await orch.run({
    baseBranch: "main",
    driveMonitor: fastDrive,
    sleep: () => Promise.resolve(),
  });

  assert.deepEqual(outcomes.map((o) => o.pieceId), ["a", "b"]);
  assert.ok(outcomes.every((o) => o.status === "merged"));
  // a's worktree created before b's (advance order).
  assert.deepEqual(created, ["a", "b"]);
  assert.equal(gh.createdPrs.length, 2);
  assert.equal(gh.mergeOrder.length, 2);
});

test("a failed implementation abandons its piece and halts the advance", async () => {
  const gh = fakeGh();
  const created: string[] = [];
  const d = await deps(gh.adapter, fakeRunner({ implOk: false }), fakeWorktrees(created));
  const workflow = def([
    { id: "a", scope: "first", worktreeName: "a", dependsOn: [] },
    { id: "b", scope: "second", worktreeName: "b", dependsOn: ["a"] },
  ]);
  const orch = new StackedPrOrchestrator(d, workflow);

  const outcomes = await orch.run({
    baseBranch: "main",
    driveMonitor: fastDrive,
    sleep: () => Promise.resolve(),
  });

  // a abandoned -> wave 1 didn't merge -> b never starts.
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.pieceId, "a");
  assert.equal(outcomes[0]!.status, "abandoned");
  assert.equal(gh.createdPrs.length, 0, "no PR filed for a failed impl");
  assert.deepEqual(created, ["a"], "b's worktree never created");
});

test("retries a transient implementation failure, then merges", async () => {
  const gh = fakeGh();
  const created: string[] = [];
  // First impl turn fails; default 2 attempts means the second succeeds.
  const d = await deps(gh.adapter, flakyImplRunner(1), fakeWorktrees(created));
  const workflow = def([{ id: "a", scope: "s", worktreeName: "a", dependsOn: [] }]);
  const orch = new StackedPrOrchestrator(d, workflow);

  const outcomes = await orch.run({
    baseBranch: "main",
    driveMonitor: fastDrive,
    sleep: () => Promise.resolve(),
  });

  assert.equal(outcomes[0]!.status, "merged");
  assert.equal(gh.createdPrs.length, 1, "PR filed once after the retry succeeds");
});

test("re-running skips already-merged pieces (partial resume)", async () => {
  const gh = fakeGh();
  const created: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), "harness-resume-"));
  const config = defaultConfig(dir);
  const store = await StateStore.open(config.stateDir);

  // Runner: piece "b" fails its impl while gate.failB is set; "a" always works.
  const gate = { failB: true };
  const runner: ThreadRunner = {
    async run(seed: string): Promise<ThreadResult> {
      if (seed.includes("You are a code reviewer")) return { ok: true, text: "[]", tokensUsed: 5 };
      const ok = !(seed.includes("b-scope") && gate.failB);
      return { ok, text: "impl", tokensUsed: 10 };
    },
  };
  const d: OrchestratorDeps = {
    gh: gh.adapter,
    runner,
    worktrees: fakeWorktrees(created),
    store,
    config,
    log,
  };
  const workflow = def([
    { id: "a", scope: "a-scope", worktreeName: "a", dependsOn: [] },
    { id: "b", scope: "b-scope", worktreeName: "b", dependsOn: ["a"] },
  ]);
  const orch = new StackedPrOrchestrator(d, workflow);
  const run = () =>
    orch.run({ baseBranch: "main", driveMonitor: fastDrive, sleep: () => Promise.resolve() });

  // Run 1: a merges, b abandons (its impl keeps failing).
  const first = await run();
  assert.equal(first.find((o) => o.pieceId === "a")!.status, "merged");
  assert.equal(first.find((o) => o.pieceId === "b")!.status, "abandoned");

  // Run 2: b now works; a must be skipped (already merged), not redone.
  gate.failB = false;
  const second = await run();
  assert.equal(second.find((o) => o.pieceId === "a")!.status, "merged");
  assert.equal(second.find((o) => o.pieceId === "b")!.status, "merged");

  assert.equal(created.filter((n) => n === "a").length, 1, "a's worktree made once");
  assert.equal(gh.createdPrs.filter((h) => h === "harness/a").length, 1, "a's PR filed once");
});

test("stacked mode bases each dependent on its parent's branch and never merges", async () => {
  // gh fake that records the base each PR is opened against.
  const prBases: Array<{ head: string; base: string }> = [];
  const mergeOrder: number[] = [];
  let next = 200;
  const gh = {
    async createPr(head: string, base: string) {
      prBases.push({ head, base });
      return ++next;
    },
    async getPr(number: number): Promise<PrState> {
      return { number, headSha: `sha-${number}`, checks: "SUCCESS", approvals: 1, mergeable: true };
    },
    async fetchComments() {
      return [];
    },
    async merge(number: number) {
      mergeOrder.push(number);
    },
  } as unknown as GitHubAdapter;

  // worktree fake that records the base each worktree is cut from.
  const wtBases: Array<{ name: string; base: string }> = [];
  const worktrees = {
    async create(name: string, base: string) {
      wtBases.push({ name, base });
      return { branch: `harness/${name}`, path: `/tmp/wt/${name}` };
    },
  } as unknown as WorktreeManager;

  const d = await deps(gh, fakeRunner(), worktrees);
  const workflow: WorkflowDefinition = {
    ...def([
      { id: "a", scope: "first", worktreeName: "a", dependsOn: [] },
      { id: "b", scope: "second", worktreeName: "b", dependsOn: ["a"] },
      { id: "c", scope: "third", worktreeName: "c", dependsOn: ["b"] },
    ]),
    advanceRule: "stack-on-parent",
  };
  const orch = new StackedPrOrchestrator(d, workflow);

  const outcomes = await orch.run({
    baseBranch: "main",
    driveMonitor: fastDrive,
    sleep: () => Promise.resolve(),
  });

  // Whole stack approved, nothing merged mid-run.
  assert.deepEqual(outcomes.map((o) => o.pieceId), ["a", "b", "c"]);
  assert.ok(outcomes.every((o) => o.status === "approved"), "approved, not merged");
  assert.equal(mergeOrder.length, 0, "stacked mode merges nothing during the run");

  // Root on main; each dependent stacked on its parent's branch — worktree + PR.
  assert.deepEqual(wtBases, [
    { name: "a", base: "main" },
    { name: "b", base: "harness/a" },
    { name: "c", base: "harness/b" },
  ]);
  assert.deepEqual(prBases, [
    { head: "harness/a", base: "main" },
    { head: "harness/b", base: "harness/a" },
    { head: "harness/c", base: "harness/b" },
  ]);
});

test("stacked mode resume skips already-approved pieces", async () => {
  const prHeads: string[] = [];
  let next = 300;
  const gh = {
    async createPr(head: string) {
      prHeads.push(head);
      return ++next;
    },
    async getPr(number: number): Promise<PrState> {
      return { number, headSha: `sha-${number}`, checks: "SUCCESS", approvals: 1, mergeable: true };
    },
    async fetchComments() {
      return [];
    },
    async merge() {},
  } as unknown as GitHubAdapter;
  const created: string[] = [];
  const d = await deps(gh, fakeRunner(), fakeWorktrees(created));
  const workflow: WorkflowDefinition = {
    ...def([{ id: "a", scope: "s", worktreeName: "a", dependsOn: [] }]),
    advanceRule: "stack-on-parent",
  };
  const orch = new StackedPrOrchestrator(d, workflow);
  const run = () =>
    orch.run({ baseBranch: "main", driveMonitor: fastDrive, sleep: () => Promise.resolve() });

  const first = await run();
  assert.equal(first[0]!.status, "approved");
  const second = await run();
  assert.equal(second[0]!.status, "approved");
  assert.equal(created.filter((n) => n === "a").length, 1, "worktree made once across reruns");
  assert.equal(prHeads.length, 1, "PR filed once — approved piece skipped on rerun");
});

test("independent pieces in a wave all merge", async () => {
  const gh = fakeGh();
  const created: string[] = [];
  const d = await deps(gh.adapter, fakeRunner(), fakeWorktrees(created));
  const workflow = def([
    { id: "core", scope: "core", worktreeName: "core", dependsOn: [] },
    { id: "mw", scope: "mw", worktreeName: "mw", dependsOn: ["core"] },
    { id: "metrics", scope: "metrics", worktreeName: "metrics", dependsOn: ["core"] },
  ]);
  const orch = new StackedPrOrchestrator(d, workflow);

  const outcomes = await orch.run({
    baseBranch: "main",
    driveMonitor: fastDrive,
    sleep: () => Promise.resolve(),
  });

  assert.equal(outcomes.length, 3);
  assert.ok(outcomes.every((o) => o.status === "merged"));
  // core is wave 1 and must precede the parallel wave 2.
  assert.equal(created[0], "core");
  assert.deepEqual(new Set(created.slice(1)), new Set(["mw", "metrics"]));
});
