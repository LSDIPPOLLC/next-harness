---
title: CLI reference
layout: default
nav_order: 4
---

# CLI reference
{: .no_toc }

Every command, flag, and default.
{: .fs-6 .fw-300 }

All commands operate on the repo in the current working directory. Run
`harness help` for the built-in summary.

<details open markdown="block">
  <summary>On this page</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## `watch` — single-PR monitor (§5A)

```
harness watch <pr> [--base main] [--auto-merge] [--once] [--permission-mode <mode>]
```

Run the single-PR monitor loop: watch a PR, self-review on each new head,
address bot/human/reviewer findings, resolve the threads it fixes, until the PR
is approved or a guard trips.

| Flag | Default | Meaning |
|------|---------|---------|
| `--base` | `main` | Branch the review diffs against |
| `--auto-merge` | off | Merge (squash) once mergeable, instead of stopping for operator merge |
| `--once` | off | Run exactly one heartbeat, then exit (cron / debugging) |
| `--permission-mode` | `bypassPermissions` | Agent permission posture |

Thread id is `pr-<n>` (use it with `harness kill`).

## `review` — one-shot self-review

```
harness review <pr> [--base main]
```

Spawn a fresh reviewer thread on the PR's diff and print findings as JSON.
Read-only — files nothing, changes nothing. The cheapest way to smoke-test your
setup.

## `compose` — goal → workflow definition (§5B setup)

```
harness compose "<goal>" [--out plan.json] [--permission-mode <mode>]
```

An agent inspects the repo, decomposes the goal into ordered pieces, and writes
`plan.json` + HTML plans. **Stops for approval — does not run.**

| Flag | Default | Meaning |
|------|---------|---------|
| `--out` | `.harness/plan.json` | Where to write the generated definition |
| `--permission-mode` | `bypassPermissions` | Posture for the inspecting agent |

Even when generation fails validation, the (invalid) definition is written so
you can edit and retry.

## `plan` — render the approval surface (§6)

```
harness plan <plan.json> [--out <dir>]
harness plan --example
```

Validate a workflow definition and render it as a skimmable HTML approval
surface (one plan per piece + an index). `--example` prints a starter definition
to stdout.

| Flag | Default | Meaning |
|------|---------|---------|
| `--out` | `.harness/plans` | Output directory for the HTML |
| `--example` | — | Print a starter definition and exit |

## `run` — stacked-PR orchestrator (§5B)

```
harness run <plan.json> [--base main] [--stacked] [--permission-mode <mode>]
```

Execute a workflow definition. Per piece: implement → file PR → review sub-loop
→ merge → advance. Pieces in a wave run concurrently; waves are a barrier.

| Flag | Default | Meaning |
|------|---------|---------|
| `--base` | `main` | Base branch for the (root) pieces |
| `--stacked` | off | True stacked PRs: dependents branch off the parent's branch; nothing merges mid-run; you merge the approved stack bottom-up |
| `--permission-mode` | `bypassPermissions` | Agent permission posture |

Re-running is idempotent: pieces already complete (merged, or approved in
stacked mode) are skipped — only unfinished work is redone.

## `grind` — linear `goal_loop` (§5C)

```
harness grind "<goal>" [--worktree <name>] [--base main] [--here] [--once] [--permission-mode <mode>]
```

One thread grinds a single goal to completion in an isolated worktree.

| Flag | Default | Meaning |
|------|---------|---------|
| `--worktree` | `grind` | Worktree name (also the thread id suffix) |
| `--base` | `main` | Base for the new worktree |
| `--here` | off | Work in the repo directly instead of a fresh worktree |
| `--once` | off | Run one iteration, then exit |
| `--permission-mode` | `bypassPermissions` | Agent permission posture |

Exits non-zero unless the loop reached `done`. Output is experimental by default
(spec §10).

## `watch-prs` — open-PR watcher (§5D)

```
harness watch-prs [--once]
```

A watch/context loop: notify on open-PR changes (new / updated / closed), deltas
only. Notifications go to stdout. `--once` checks once and exits.

## `worktree` — manage isolated checkouts (§3, P4)

```
harness worktree create <name> [--base main]
harness worktree teardown <name> [--force]
harness worktree list
```

`create` is idempotent (reuses an existing worktree at the path) and seeds a
local git identity. `teardown --force` discards uncommitted changes (abandon).

## `state` — dump persisted state

```
harness state
```

Print the full `.harness/state.json` — threads, budgets, findings, watch
digests.

## `kill` — request a clean stop

```
harness kill <threadId>
```

Set the kill flag on a thread; honored at its next heartbeat (worktree isolation
makes the stop clean). Thread ids: `pr-<n>` (watch), `grind-<name>` (grind),
`piece-<id>` / `orchestrator` (run), `watch-prs` (watcher).

## `help`

```
harness help
```

Print the command summary.

---

## Environment variables

| Variable | Effect |
|----------|--------|
| `HARNESS_LOG=silent` | Suppress all logging (used by the test suite) |
| `HARNESS_GIT_NAME` | Committer name set in each worktree (default `next-harness`) |
| `HARNESS_GIT_EMAIL` | Committer email (default `harness@localhost`) |

Permission modes: `bypassPermissions` (default for loops), `acceptEdits`,
`plan`, `default`. See [Getting started → Permission posture](getting-started#permission-posture-important).
