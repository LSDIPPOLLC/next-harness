import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard } from "../src/guards.ts";
import { StateStore } from "../src/state-store.ts";
import { makeLogger } from "../src/log.ts";
import { defaultConfig, type GuardLimits } from "../src/config.ts";
import { SinglePrMonitor, type MonitorDeps } from "../src/loops/single-pr-monitor.ts";
import type { GitHubAdapter, PrComment } from "../src/adapters/github.ts";
import type { ThreadRunner, RunOptions } from "../src/adapters/thread-runner.ts";
import type { PrState, Thread, ThreadResult } from "../src/types.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

interface GhRecorder {
  adapter: GitHubAdapter;
  comments: string[];
  resolvedThreads: string[];
}

function fakeGh(opts: {
  pr: PrState;
  comments?: PrComment[];
  onMerge?: () => void;
}): GhRecorder {
  const comments: string[] = [];
  const resolvedThreads: string[] = [];
  const adapter = {
    getPr: async () => opts.pr,
    fetchComments: async () => opts.comments ?? [],
    merge: async () => opts.onMerge?.(),
    postComment: async (_n: number, body: string) => {
      comments.push(body);
    },
    resolveReviewThread: async (threadId: string) => {
      resolvedThreads.push(threadId);
    },
  } as unknown as GitHubAdapter;
  return { adapter, comments, resolvedThreads };
}

/**
 * A fake worktree HEAD that a successful worker advances, mirroring a real
 * `git commit`. The monitor only marks a finding resolved when HEAD moves, so
 * `workerCommits` lets a test simulate the "reported success but never
 * committed" case (ok:true, HEAD unchanged).
 */
function fakeRunner(opts: {
  reviewFindings?: Array<{ area: string; body: string }>;
  reviewTokens?: number;
  workerOk?: boolean;
  workerTokens?: number;
  /** Whether a successful worker advances HEAD. Defaults to true. */
  workerCommits?: boolean;
}): { runner: ThreadRunner; readHead: (cwd: string) => Promise<string | null> } {
  let head = 0;
  const runner: ThreadRunner = {
    async run(seed: string, _o: RunOptions): Promise<ThreadResult> {
      const isReview = seed.includes("You are a code reviewer");
      if (isReview) {
        return {
          ok: true,
          text: JSON.stringify(opts.reviewFindings ?? []),
          tokensUsed: opts.reviewTokens ?? 100,
        };
      }
      const ok = opts.workerOk ?? true;
      if (ok && (opts.workerCommits ?? true)) head += 1;
      return { ok, text: "done", tokensUsed: opts.workerTokens ?? 50 };
    },
  };
  return { runner, readHead: async () => `sha-${head}` };
}

async function setup(
  guardOver: Partial<GuardLimits> = {},
): Promise<{ store: StateStore; config: ReturnType<typeof defaultConfig>; threadId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  const config = defaultConfig(dir);
  config.guards = { ...config.guards, maxWorkPerHeartbeat: 5, ...guardOver };
  const store = await StateStore.open(config.stateDir);
  const threadId = "pr-1";
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
  return { store, config, threadId };
}

function deps(
  store: StateStore,
  config: ReturnType<typeof defaultConfig>,
  gh: GhRecorder,
  bundle: { runner: ThreadRunner; readHead: (cwd: string) => Promise<string | null> },
): MonitorDeps {
  return {
    gh: gh.adapter,
    runner: bundle.runner,
    readHead: bundle.readHead,
    guard: new Guard(config.guards),
    store,
    config,
    log,
  };
}

test("new head spawns a reviewer and addresses bot + reviewer findings", async () => {
  const { store, config, threadId } = await setup();
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  const gh = fakeGh({
    pr,
    comments: [
      { id: "issue:9", author: "coderabbit", body: "fix null check", isBot: true, area: "a.ts:3" },
    ],
  });
  const runner = fakeRunner({ reviewFindings: [{ area: "b.ts:5", body: "missing await" }] });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  const result = await monitor.tick();
  assert.equal(result, "continue");

  const t = store.getThread(threadId)!;
  assert.equal(t.lastReviewedSha, "sha1");
  assert.equal(t.status, "awaiting_review");

  // Compaction: both the bot comment and the reviewer finding were addressed,
  // so they're removed from the array and tracked as resolved ids instead.
  assert.equal(store.getFindings(threadId).length, 0, "addressed findings compacted out");
  assert.equal(t.loopState?.resolvedFindingIds?.length, 2, "both ids remembered");
  // reviewer 100 + two workers * 50
  assert.equal(t.budget.tokensUsed, 200);
});

test("a resolved bot comment is not resurrected when re-fetched", async () => {
  const { store, config, threadId } = await setup();
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  const comment = {
    id: "issue:9",
    author: "coderabbit",
    body: "fix null check",
    isBot: true,
    area: "a.ts:3",
  };
  // Same comment is returned every heartbeat (bots leave their comment up).
  const gh = fakeGh({ pr, comments: [comment] });
  const runner = fakeRunner({ reviewFindings: [] });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  await monitor.tick(); // addresses + compacts the comment
  await monitor.tick(); // re-fetches the same comment — must NOT re-add it

  assert.equal(store.getFindings(threadId).length, 0, "not resurrected");
  assert.deepEqual(store.getThread(threadId)!.loopState?.resolvedFindingIds, ["issue:9"]);
});

test("resolving an inline review-thread finding resolves the thread and acks on the PR", async () => {
  const { store, config, threadId } = await setup();
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  // An inline review comment carries its GraphQL thread id.
  const gh = fakeGh({
    pr,
    comments: [
      {
        id: "review:THREAD_ABC",
        author: "coderabbit",
        body: "guard the null case",
        isBot: true,
        area: "src.js:4",
        threadId: "THREAD_ABC",
      },
    ],
  });
  const runner = fakeRunner({ reviewFindings: [] });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  await monitor.tick();

  // The thread the finding came from is resolved (clears the merge gate)...
  assert.deepEqual(gh.resolvedThreads, ["THREAD_ABC"]);
  // ...and a single acknowledgment comment names the area it addressed.
  assert.equal(gh.comments.length, 1, "one summary comment per tick");
  assert.match(gh.comments[0]!, /src\.js:4/);
  assert.match(gh.comments[0]!, /next-harness addressed 1 review finding/);
});

test("a non-thread finding is acked but no thread is resolved", async () => {
  const { store, config, threadId } = await setup();
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  // A top-level issue comment has no thread to resolve.
  const gh = fakeGh({
    pr,
    comments: [
      { id: "issue:9", author: "alice", body: "rename this", isBot: false, area: "general" },
    ],
  });
  const runner = fakeRunner({ reviewFindings: [] });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  await monitor.tick();

  assert.deepEqual(gh.resolvedThreads, [], "no inline thread to resolve");
  assert.equal(gh.comments.length, 1, "still acknowledged with a comment");
});

test("a worker that reports success but never commits leaves the finding open", async () => {
  const { store, config, threadId } = await setup();
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  const gh = fakeGh({ pr });
  // Worker claims success but HEAD never advances (e.g. a failed `git commit`).
  const runner = fakeRunner({
    reviewFindings: [{ area: "src.js:4", body: "fix it" }],
    workerOk: true,
    workerCommits: false,
  });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  const result = await monitor.tick();
  assert.equal(result, "continue");

  const t = store.getThread(threadId)!;
  // Not marked resolved: stays in the array, no resolved id, status "fixing".
  assert.equal(store.getFindings(threadId).length, 1, "finding remains open");
  assert.equal(t.loopState?.resolvedFindingIds?.length ?? 0, 0, "nothing marked resolved");
  assert.equal(gh.comments.length, 0, "no ack posted for an unverified fix");
  assert.equal(t.status, "fixing");
  // tokens still accrue for the failed attempt: reviewer 100 + worker 50.
  assert.equal(t.budget.tokensUsed, 150);
});

test("mergeable + no findings -> approved, no auto-merge", async () => {
  const { store, config, threadId } = await setup();
  let merged = false;
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "SUCCESS",
    approvals: 1,
    mergeable: true,
  };
  const gh = fakeGh({ pr, comments: [], onMerge: () => (merged = true) });
  const runner = fakeRunner({ reviewFindings: [] });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  const result = await monitor.tick();
  assert.equal(result, "done");
  assert.equal(merged, false);
  assert.equal(store.getThread(threadId)!.status, "approved");
});

test("mergeable + auto-merge -> merges and marks merged", async () => {
  const { store, config, threadId } = await setup();
  let merged = false;
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "SUCCESS",
    approvals: 1,
    mergeable: true,
  };
  const gh = fakeGh({ pr, comments: [], onMerge: () => (merged = true) });
  const monitor = new SinglePrMonitor(
    deps(store, config, gh, fakeRunner({ reviewFindings: [] })),
    { threadId, prNumber: 1, worktreePath: "/tmp/wt", baseBranch: "main", autoMerge: true },
  );

  const result = await monitor.tick();
  assert.equal(result, "done");
  assert.equal(merged, true);
  assert.equal(store.getThread(threadId)!.status, "merged");
});

test("divergence on a repeatedly-touched area halts and escalates", async () => {
  const { store, config, threadId } = await setup({ divergenceThreshold: 1 });
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  // Worker reports failure so the finding never resolves -> keeps re-touching.
  const gh = fakeGh({ pr });
  const runner = fakeRunner({
    reviewFindings: [{ area: "loop.ts:1", body: "spins" }],
    workerOk: false,
  });
  const monitor = new SinglePrMonitor(deps(store, config, gh, runner), {
    threadId,
    prNumber: 1,
    worktreePath: "/tmp/wt",
    baseBranch: "main",
    autoMerge: false,
  });

  const result = await monitor.tick();
  assert.equal(result, "done");
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("resumes divergence counters after a restart (persisted loopState)", async () => {
  const { store, config, threadId } = await setup({ divergenceThreshold: 2 });
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  const gh = fakeGh({ pr });
  // Worker keeps failing, so the finding stays unresolved and area "x" is
  // re-touched each tick.
  const runner = fakeRunner({
    reviewFindings: [{ area: "x", body: "spins" }],
    workerOk: false,
  });
  const mk = () =>
    new SinglePrMonitor(deps(store, config, gh, runner), {
      threadId,
      prNumber: 1,
      worktreePath: "/tmp/wt",
      baseBranch: "main",
      autoMerge: false,
    });

  const a = mk();
  assert.equal(await a.tick(), "continue");
  assert.equal(store.getThread(threadId)!.loopState!.touchCounts!["x"], 1);

  // Restart: the fresh monitor must resume the count, not reset it. It also
  // won't re-spawn a reviewer (lastReviewedSha persisted), so the same
  // unresolved finding is re-touched: 1 -> 2 -> divergence halt.
  const b = mk();
  assert.equal(await b.tick(), "done");
  assert.equal(store.getThread(threadId)!.status, "halted");
});

test("kill-switch flag halts at next tick", async () => {
  const { store, config, threadId } = await setup();
  await store.update((s) => {
    s.threads[threadId]!.killRequested = true;
  });
  const pr: PrState = {
    number: 1,
    headSha: "sha1",
    checks: "PENDING",
    approvals: 0,
    mergeable: false,
  };
  const monitor = new SinglePrMonitor(
    deps(store, config, fakeGh({ pr }), fakeRunner({})),
    { threadId, prNumber: 1, worktreePath: "/tmp/wt", baseBranch: "main", autoMerge: false },
  );

  const result = await monitor.tick();
  assert.equal(result, "done");
  assert.equal(store.getThread(threadId)!.status, "halted");
});
