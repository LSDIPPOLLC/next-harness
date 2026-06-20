# next-harness

Dynamic loop orchestration for Claude Code — **loops that prompt agents**
instead of prompting agents step by step. Implements the MVP rungs of the
[harness spec](#spec-mapping): the operator seeds the work and approves; the
harness files, reviews, fixes, and advances within a budget.

> Requires **Node ≥ 24** (runs TypeScript natively — no build step), plus the
> `gh` and `claude` CLIs on `PATH`.

📖 **Full documentation site:** [`docs/`](docs/) — onboarding, concepts, CLI
reference, recipes, and an honest [spec mapping & gap analysis](docs/spec-gaps.md).
Built for GitHub Pages (Settings → Pages → Deploy from branch → `/docs`).

## What's built (rollout steps 1–3 of §11)

| Step | Capability | Where |
|------|-----------|-------|
| 1 | **Worktree isolation** — isolated checkout per unit of work (P4) | `src/adapters/worktree.ts` |
| 2 | **Single-PR monitor loop (§5A)** — heartbeat watches a PR, addresses bot/human/reviewer findings until approved or a guard trips | `src/loops/single-pr-monitor.ts` |
| 3 | **Self-review chaining** — worker spawns a *fresh* reviewer thread per new SHA and ingests its findings ("look late", P5) | `src/loops/self-review.ts` |
| 4 | **HTML plans + approval surface (§6)** — workflow-definition contract, validation/ordering into parallel waves, skimmable per-piece HTML + index | `src/plan.ts`, `src/plan-store.ts` |
| 5 | **Dynamic stacked-PR meta-workflow (§5B)** — orchestrator drives each piece implement → file PR → review sub-loop → merge → advance; concurrent within a wave, barrier between waves (P3 loops-create-loops). Transient steps retry with backoff; re-running skips already-completed pieces (partial resume). `--stacked` builds true stacked PRs (dependents branch off the parent's branch, nothing merges mid-run) | `src/loops/orchestrator.ts`, `src/retry.ts` |
| 5 | **Goal → definition generation (§5B setup, P1/P2)** — an agent inspects the repo and decomposes a goal into an ordered, validated `WorkflowDefinition`; stops for approval (§8) | `src/loops/compose.ts` |
| 7 | **Linear `goal_loop` grinder (§5C)** — one thread grinds a single goal to completion in an isolated worktree; self-reports done/next each turn, halts on no-progress (§9 divergence analog) | `src/loops/goal-loop.ts` |
| 7 | **Watch/context loops (§5D)** — heartbeat + injected observer + pluggable `Notifier`; notifies only on deltas. Ships an open-PR watcher | `src/loops/watch.ts`, `src/adapters/notifier.ts` |
| — | **Thread state model (§7)** — durable, atomic, concurrency-safe state | `src/types.ts`, `src/state-store.ts` |
| — | **Guards (§9)** — token / wall-clock / per-heartbeat caps, divergence detection, kill-switch | `src/guards.ts` |
| — | **Runtime primitives (§3)** — `spawn_thread`/`run_external`, `heartbeat`, `worktree` as pluggable adapters | `src/adapters/`, `src/heartbeat.ts` |

## Usage

```bash
# One-shot self-review of a PR's diff (prints findings JSON)
node src/cli.ts review 123 --base main

# Run the single-PR monitor loop until approved or a guard trips
node src/cli.ts watch 123 --base main

# Run exactly one heartbeat (good for cron / debugging)
node src/cli.ts watch 123 --once

# Auto-merge once mergeable instead of stopping for operator merge (§8)
node src/cli.ts watch 123 --auto-merge

# Generate a workflow from a goal — an agent decomposes it into ordered
# pieces, writes plan.json + HTML plans, and STOPS for your approval (§8)
node src/cli.ts compose "add rate limiting to the public API"

# (or hand-write one) Render a definition into an HTML approval surface (§6)
node src/cli.ts plan --example > plan.json
node src/cli.ts plan plan.json            # writes .harness/plans/index.html

# After approving, execute through the §5B stacked-PR orchestrator
node src/cli.ts run plan.json --base main

# True stacked PRs: each dependent branches off its parent's PR branch and
# nothing merges mid-run (you merge the approved stack bottom-up)
node src/cli.ts run plan.json --stacked

# Linear grinder (§5C): one thread works a single goal to completion
node src/cli.ts grind "port the test suite from mocha to node:test" --once

# Watch/context loop (§5D): notify on open-PR changes, deltas only
node src/cli.ts watch-prs --once

# Inspect / control state
node src/cli.ts state
node src/cli.ts kill pr-123        # honored at next heartbeat
node src/cli.ts worktree list
```

`harness watch <pr>` attaches a worktree to the PR's head branch under
`.harness/worktrees/`, then each heartbeat (default 7 min):

1. Checks guards (kill-switch, tokens, wall-clock).
2. Reads PR state into the §7 shape.
3. On a **new head SHA**, spawns a fresh reviewer thread (the key §7 transition).
4. Folds in bot + human comments as findings.
5. Addresses unresolved findings (capped per wake), each via a worker thread
   that commits and pushes. A finding is only marked resolved if the branch
   head actually advanced ("look late" verification, §8) — a worker that
   reports success without committing leaves the finding open to re-touch.
6. Closes the loop on the PR: resolves each inline review thread it fixed (via
   GraphQL `resolveReviewThread`, so "require conversation resolution" merge
   gates clear) and posts one summary "addressed in `<sha>`" comment per tick.
7. Halts on divergence; when mergeable and clean, approves (or auto-merges).

## Run it

```bash
npm install        # @types/node + typescript (for typecheck only)
npm run typecheck  # tsc --noEmit
npm test           # node --test
```

Set `HARNESS_LOG=silent` to fully quiet a run (tests already do this).

The permission posture for spawned agents defaults to **`bypassPermissions`**;
override with `--permission-mode`. The loops fundamentally need to run Bash
(`git commit`, `git push`) with no human to approve it — `acceptEdits` would
auto-approve file edits but still gate Bash, so a worker would silently edit
without committing. Agents run **inside the worktree**, which is the
blast-radius limit (§9/P4) and exactly the justification for bypassing — keep
them there. Each worktree also gets a local git identity (override via
`HARNESS_GIT_NAME` / `HARNESS_GIT_EMAIL`) so unattended commits never fail.

## Spec mapping

This implements the full §11 rollout order. Cross-cutting pieces the spec
lists separately (§3 primitives, §7 state model, §9 guards) are built because
the loops can't exist safely without them.

The full §5B path now works end to end: `compose` a goal into a definition →
review the HTML → `run` the orchestrator.

## Rollout status

All canonical loop shapes in the spec are now implemented: the single-PR
monitor (§5A), the dynamic stacked-PR meta-workflow (§5B) with goal→definition
generation, the linear `goal_loop` grinder (§5C), and watch/context loops
(§5D) — on the §3 primitives, §6 plan contract, §7 state model, and §9 guards.

The §5A path is **validated live** against a real GitHub repo + PR (review →
reviewer findings → worker commits & pushes → verified head advance), which
surfaced and fixed four real defects the in-memory fakes couldn't reach
(non-idempotent worktree attach, missing committer identity, unverified
"resolved" findings, and the `acceptEdits` Bash gate). The full §5B/stacked
merge cycle can't be exercised on a single GitHub account — it gates on a PR
approval you can't give your own PR — but every primitive it composes is
live-validated. See `FOLLOWUPS.md` for the running action list.

## Design notes

- **Pluggable runtime.** `ThreadRunner` is an interface; today it shells out to
  `claude -p --output-format json`, but an Agent-SDK runner drops in without
  touching the loops.
- **Durable state.** All progress lives in `.harness/state.json` (atomic
  writes), so a loop survives process restarts and a `--once` cron cadence
  works as well as a long-running process.
- **Look late (P5).** No human reads agent output before a reviewer pass runs.
