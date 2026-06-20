import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard } from "../src/guards.ts";
import { StateStore } from "../src/state-store.ts";
import { makeLogger } from "../src/log.ts";
import { defaultConfig } from "../src/config.ts";
import { WatchLoop, type Observation, type WatchDeps } from "../src/loops/watch.ts";
import type { Notifier } from "../src/adapters/notifier.ts";
import type { Thread } from "../src/types.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

class CollectingNotifier implements Notifier {
  messages: string[] = [];
  async notify(message: string): Promise<void> {
    this.messages.push(message);
  }
}

function obs(key: string, digest: string, summary = key): Observation {
  return { key, digest, summary };
}

async function setup(): Promise<{
  store: StateStore;
  deps: (observer: WatchDeps["observer"], notifier: Notifier) => WatchDeps;
  threadId: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "harness-watch-"));
  const config = defaultConfig(dir);
  const store = await StateStore.open(config.stateDir);
  const threadId = "watch-x";
  const thread: Thread = {
    id: threadId,
    role: "watcher",
    worktree: null,
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
  const deps = (observer: WatchDeps["observer"], notifier: Notifier): WatchDeps => ({
    observer,
    notifier,
    guard: new Guard(config.guards),
    store,
    config,
    log,
  });
  return { store, deps, threadId };
}

// An observer that returns a different snapshot on each tick.
function steppedObserver(snapshots: Observation[][]): WatchDeps["observer"] {
  let i = 0;
  return async () => snapshots[Math.min(i++, snapshots.length - 1)]!;
}

test("first observation reports everything as new; identical second reports nothing", async () => {
  const { deps, threadId } = await setup();
  const notifier = new CollectingNotifier();
  const observer = steppedObserver([
    [obs("pr-1", "a"), obs("pr-2", "b")],
    [obs("pr-1", "a"), obs("pr-2", "b")], // unchanged
  ]);
  const loop = new WatchLoop(deps(observer, notifier), { threadId, name: "prs" });

  await loop.tick();
  await loop.tick();

  assert.equal(notifier.messages.length, 1, "only the first tick notifies");
  assert.match(notifier.messages[0]!, /New:/);
  assert.match(notifier.messages[0]!, /pr-1/);
});

test("a changed digest notifies as Updated", async () => {
  const { deps, threadId } = await setup();
  const notifier = new CollectingNotifier();
  const observer = steppedObserver([
    [obs("pr-1", "a")],
    [obs("pr-1", "a2", "#1 now approved")],
  ]);
  const loop = new WatchLoop(deps(observer, notifier), { threadId, name: "prs" });

  await loop.tick(); // new
  await loop.tick(); // changed

  assert.equal(notifier.messages.length, 2);
  assert.match(notifier.messages[1]!, /Updated:/);
  assert.match(notifier.messages[1]!, /now approved/);
});

test("a removed key notifies as Gone", async () => {
  const { deps, threadId } = await setup();
  const notifier = new CollectingNotifier();
  const observer = steppedObserver([[obs("pr-1", "a"), obs("pr-2", "b")], [obs("pr-1", "a")]]);
  const loop = new WatchLoop(deps(observer, notifier), { threadId, name: "prs" });

  await loop.tick();
  await loop.tick();

  assert.equal(notifier.messages.length, 2);
  assert.match(notifier.messages[1]!, /Gone:/);
  assert.match(notifier.messages[1]!, /pr-2/);
});

test("watcher persists the last-seen snapshot and bumps iterations", async () => {
  const { store, deps, threadId } = await setup();
  const observer = steppedObserver([[obs("pr-1", "a")]]);
  const loop = new WatchLoop(deps(observer, new CollectingNotifier()), { threadId, name: "prs" });

  await loop.tick();

  assert.deepEqual(store.getWatch(threadId), { "pr-1": "a" });
  assert.equal(store.getThread(threadId)!.budget.iterations, 1);
});

test("kill-switch stops the watch loop", async () => {
  const { store, deps, threadId } = await setup();
  await store.update((s) => {
    s.threads[threadId]!.killRequested = true;
  });
  const observer = steppedObserver([[obs("pr-1", "a")]]);
  const notifier = new CollectingNotifier();
  const loop = new WatchLoop(deps(observer, notifier), { threadId, name: "prs" });

  assert.equal(await loop.tick(), "done");
  assert.equal(store.getThread(threadId)!.status, "done");
  assert.equal(notifier.messages.length, 0, "killed before observing");
});
