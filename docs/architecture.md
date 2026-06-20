---
title: Architecture
layout: default
nav_order: 6
---

# Architecture
{: .no_toc }

How the code is laid out, and how to extend it.
{: .fs-6 .fw-300 }

<details open markdown="block">
  <summary>On this page</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## Design stance

Everything the harness touches the outside world through is an **interface with
a default implementation**. The loops depend on the interfaces, never the
concrete tools, so you can swap the agent runtime, the PR host, or the
notification sink without editing a loop. Three cross-cutting concerns —
[state](concepts#threads--state-7), [guards](concepts#guards-9), and the
[primitives](concepts#runtime-primitives-3) — are shared by every loop.

No build step: Node ≥ 24 runs the `.ts` sources directly.

## Module map

### Core
{: #core }

| Module | Responsibility |
|--------|----------------|
| `src/types.ts` | The §7 state model: `Thread`, `ReviewFinding`, `PrState`, `LoopState`, `HarnessState` |
| `src/config.ts` | `HarnessConfig` + `GuardLimits` and their defaults |
| `src/state-store.ts` | Durable, atomic, concurrency-safe `.harness/state.json` (serialized write queue, pid-unique temp + rename) |
| `src/guards.ts` | `Guard`: token / wall-clock / per-heartbeat caps, divergence, kill-switch |
| `src/heartbeat.ts` | Non-overlapping interval driver; first wake fires immediately |
| `src/exec.ts` | Promise wrapper around `child_process.spawn` (`run_external`) |
| `src/retry.ts` | Bounded retry with linear backoff + injectable sleep |
| `src/parse-json.ts` | Tolerant JSON extraction from agent text |
| `src/log.ts` | Tagged logger (`HARNESS_LOG=silent` to quiet) |

### Loops
{: #loops }

| Module | Loop |
|--------|------|
| `src/loops/single-pr-monitor.ts` | §5A single-PR monitor |
| `src/loops/self-review.ts` | Fresh reviewer thread per head |
| `src/loops/orchestrator.ts` | §5B stacked-PR orchestrator (waves, sub-loops, stacked mode) |
| `src/loops/compose.ts` | Goal → `WorkflowDefinition` generation |
| `src/loops/goal-loop.ts` | §5C linear grinder |
| `src/loops/watch.ts` | §5D watch/context loop |
| `src/plan.ts` | §6 contract: `WorkflowDefinition`, validation, topological waves |
| `src/plan-store.ts` | HTML approval-surface rendering |

### Adapters
{: #adapters }

| Module | Interface | Default |
|--------|-----------|---------|
| `src/adapters/thread-runner.ts` | `ThreadRunner` | `ClaudeCliRunner` (`claude -p --output-format json`) |
| `src/adapters/worktree.ts` | — | `WorktreeManager` (`git worktree`) |
| `src/adapters/github.ts` | — | `GitHubAdapter` (`gh` REST + GraphQL) |
| `src/adapters/notifier.ts` | `Notifier` | `StdoutNotifier`, `LogNotifier` |

## Configuration

Defaults live in `src/config.ts`:

```ts
DEFAULT_GUARDS = {
  maxTokens: 1_500_000,
  maxWorkPerHeartbeat: 4,
  maxWallClockMs: 4 * 60 * 60 * 1000,   // 4h
  divergenceThreshold: 4,
}
// heartbeatMs: 7 * 60 * 1000            // 7 min, inside the spec's 5–10 min band
```

State and worktrees are rooted at `<repo>/.harness/`. A workflow definition can
override `heartbeatMs` and `budget` per run (they ride along in `plan.json`).

## Extending

### Swap the agent runtime

Implement `ThreadRunner`:

```ts
interface ThreadRunner {
  run(seed: string, opts: RunOptions): Promise<ThreadResult>;
}
```

`ThreadResult` reports `{ ok, text, tokensUsed }` so the `Guard` can keep
counting tokens. An Agent-SDK or alternate-CLI runner drops in here; the loops
don't change. (`parseClaudeJson` is exported and unit-tested against the
`claude` CLI's JSON + stream-json shapes.)

### Add a notifier

Implement `Notifier`:

```ts
interface Notifier {
  notify(message: string): Promise<void>;
}
```

Pass it into a `WatchLoop` in place of `StdoutNotifier`. A Slack/Discord/chat
sink is the obvious one to add — see the [gap note](spec-gaps#5d--watch--context-loops).

### Target a non-GitHub host

`GitHubAdapter` is concrete today, but the loops only use a narrow slice of it
(`getPr`, `fetchComments`, `createPr`, `merge`, `postComment`,
`resolveReviewThread`, `listOpenPrs`). Extract that surface into an interface and
provide a GitLab/Gitea implementation; the monitor and orchestrator are agnostic.

## Tests

```bash
npm run typecheck      # tsc --noEmit
npm test               # node --test  (59 tests)
```

Tests use injected fakes for `gh`, the runner, worktrees, and `readHead`, so the
loops are exercised without spawning real agents or touching the network. The
adapters' real `gh` REST/GraphQL paths are validated by hand against a live PR
(the fakes can't catch API shape drift — see the
[shakedown notes](spec-gaps#what-the-live-run-found)).
