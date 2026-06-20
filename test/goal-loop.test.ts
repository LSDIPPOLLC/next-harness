import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard } from "../src/guards.ts";
import { StateStore } from "../src/state-store.ts";
import { makeLogger } from "../src/log.ts";
import { defaultConfig } from "../src/config.ts";
import { GoalLoop, type GoalLoopDeps } from "../src/loops/goal-loop.ts";
import type { ThreadRunner, RunOptions } from "../src/adapters/thread-runner.ts";
import type { Thread, ThreadResult } from "../src/types.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

// A runner that replays a scripted sequence of turn outputs.
function scriptedRunner(turns: Array<{ text: string; ok?: boolean }>): ThreadRunner {
  let i = 0;
  return {
    async run(_seed: string, _o: RunOptions): Promise<ThreadResult> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      return { ok: turn!.ok ?? true, text: turn!.text, tokensUsed: 30 };
    },
  };
}

async function setup(
  guardOver: Partial<GoalLoopDeps["config"]["guards"]> = {},
): Promise<{ store: StateStore; deps: (r: ThreadRunner) => GoalLoopDeps; threadId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harness-grind-"));
  const config = defaultConfig(dir);
  config.guards = { ...config.guards, ...guardOver };
  const store = await StateStore.open(config.stateDir);
  const threadId = "grind-x";
  const thread: Thread = {
    id: threadId,
    role: "worker",
    worktree: "/tmp/wt",
    pieceId: null,
    pr: null,
    status: "implementing",
    lastReviewedSha: null,
    killRequested: false,
    budget: { tokensUsed: 0, iterations: 0, startedAt: Date.now() },
    notes: [],
  };
  await store.update((s) => {
    s.threads[threadId] = thread;
  });
  const deps = (r: ThreadRunner): GoalLoopDeps => ({
    runner: r,
    guard: new Guard(config.guards),
    store,
    config,
    log,
  });
  return { store, deps, threadId };
}

// Drive a grinder to completion (bounded).
async function drive(loop: GoalLoop): Promise<number> {
  for (let i = 1; i <= 20; i++) {
    if ((await loop.tick()) === "done") return i;
  }
  throw new Error("grinder did not converge");
}

test("grinds until the agent reports done", async () => {
  const { store, deps, threadId } = await setup();
  const runner = scriptedRunner([
    { text: '{"done":false,"summary":"scaffolded module","next":"add tests"}' },
    { text: '{"done":false,"summary":"added tests","next":"wire it up"}' },
    { text: '{"done":true,"summary":"wired up and verified","next":""}' },
  ]);
  const loop = new GoalLoop(deps(runner), { threadId, goal: "rewrite X", worktreePath: "/tmp/wt" });

  const iters = await drive(loop);
  assert.equal(iters, 3);

  const t = store.getThread(threadId)!;
  assert.equal(t.status, "done");
  assert.equal(t.budget.iterations, 3);
  assert.equal(t.budget.tokensUsed, 90);
  // One running-log note per iteration.
  assert.equal(t.notes.filter((n) => n.startsWith("iter ")).length, 3);
});

test("halts on no fresh progress (divergence analog)", async () => {
  const { store, deps, threadId } = await setup({ divergenceThreshold: 2 });
  // Same summary every turn, never done -> stalled.
  const runner = scriptedRunner([
    { text: '{"done":false,"summary":"still stuck","next":"???"}' },
  ]);
  const loop = new GoalLoop(deps(runner), { threadId, goal: "impossible", worktreePath: "/tmp/wt" });

  await drive(loop);
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("unparseable turn counts as no-progress and eventually halts", async () => {
  const { store, deps, threadId } = await setup({ divergenceThreshold: 2 });
  const runner = scriptedRunner([{ text: "I am confused and produced no JSON." }]);
  const loop = new GoalLoop(deps(runner), { threadId, goal: "g", worktreePath: "/tmp/wt" });

  await drive(loop);
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("resumes its no-progress streak after a restart (persisted loopState)", async () => {
  const { store, deps, threadId } = await setup({ divergenceThreshold: 2 });
  const mk = () =>
    new GoalLoop(
      deps(scriptedRunner([{ text: '{"done":false,"summary":"a","next":"n"}' }])),
      { threadId, goal: "g", worktreePath: "/tmp/wt" },
    );

  const a = mk();
  assert.equal(await a.tick(), "continue"); // baseline
  assert.equal(await a.tick(), "continue"); // streak 1

  const ls = store.getThread(threadId)!.loopState!;
  assert.equal(ls.noProgress, 1, "streak persisted");
  assert.equal(ls.lastNext, "n", "continuation note persisted");

  // A fresh instance = simulated restart. Without persistence it would start
  // the streak at 0 and NOT halt on a single identical turn.
  const b = mk();
  assert.equal(await b.tick(), "done"); // streak resumes 1 -> 2 -> halt
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("kill-switch halts the grinder at the next tick", async () => {
  const { store, deps, threadId } = await setup();
  await store.update((s) => {
    s.threads[threadId]!.killRequested = true;
  });
  const runner = scriptedRunner([{ text: '{"done":false,"summary":"x","next":"y"}' }]);
  const loop = new GoalLoop(deps(runner), { threadId, goal: "g", worktreePath: "/tmp/wt" });

  assert.equal(await loop.tick(), "done");
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("a fresh summary resets the no-progress streak and delays the halt", async () => {
  const { store, deps, threadId } = await setup({ divergenceThreshold: 2 });
  // The first turn sets the baseline (never stalled). Identical turns then
  // accrue the streak. Sequence a, a, b, b, b...:
  //   iter1 a -> baseline      iter2 a -> streak 1
  //   iter3 b -> reset to 0    iter4 b -> streak 1   iter5 b -> streak 2 -> halt
  // Without the reset at iter3, three a's would have halted at iter3.
  const runner = scriptedRunner([
    { text: '{"done":false,"summary":"a","next":"n"}' },
    { text: '{"done":false,"summary":"a","next":"n"}' },
    { text: '{"done":false,"summary":"b","next":"n"}' }, // fresh -> reset
  ]);
  const loop = new GoalLoop(deps(runner), { threadId, goal: "g", worktreePath: "/tmp/wt" });

  const iters = await drive(loop);
  assert.equal(iters, 5, "reset pushed the halt from iter 3 to iter 5");
  assert.equal(store.getThread(threadId)!.status, "halted");
});
