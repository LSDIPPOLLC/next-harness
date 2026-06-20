---
title: Spec mapping & gaps
layout: default
nav_order: 7
---

# Spec mapping & gaps
{: .no_toc }

An honest accounting of what next-harness implements from the original
*Dynamic Loop Orchestration* spec — and what it doesn't.
{: .fs-6 .fw-300 }

<details open markdown="block">
  <summary>On this page</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## How to read this

Every row maps a spec element to its implementation status. Legend:

- ✅ **Done** — implemented and tested.
- ◐ **Partial** — implemented in a narrower form than the spec describes.
- ❌ **Gap** — not implemented.
- ➖ **N/A in code** — a policy or economic stance the code can't enforce.

If you only read one section, read [The gaps that matter](#the-gaps-that-matter).

## The gaps that matter

These are the differences worth knowing before you trust a loop:

1. **Behavioral verification is missing (the biggest gap).** The spec's
   delegation ladder rungs 1–2 — *run the dev server* and *verify the change
   actually works via computer use* — are not implemented, and the
   `computer_use()` primitive (§3) doesn't exist. The harness verifies that a
   fix **committed and advanced the branch head**, not that it **works**. There
   is no dev-server run, no browser check, and no enforced test/build gate before
   a finding is marked resolved. A worker can commit a plausible-but-wrong fix
   and the loop will treat it as done. **Mitigation:** rely on your CI checks
   (the monitor reads `statusCheckRollup` into `PrState.checks` and won't call a
   PR mergeable if checks are failing) and on the reviewer pass — but neither is
   the same as the spec's "verify it runs."

2. **Self-review uses the same agent, not a distinct second tool.** The spec's
   `run_external(cmd)` envisions invoking a *different* coding agent / review bot
   and ingesting its output. Here the reviewer thread is another `claude -p`
   invocation. External review **bots** (CodeRabbit etc.) are still ingested via
   PR comments (rung 5), so this is partial, not absent.

3. **Notifications only reach stdout/log.** §5D describes pushing alerts to a
   chat channel. The `Notifier` interface is pluggable and an open-PR observer
   ships, but no chat sink (Slack/Discord) is built.

4. **The full §5B acceptance test isn't demonstrable on a single account.** Not a
   code gap — a GitHub constraint. See [the acceptance test](#acceptance-test).

Everything else in the spec is implemented; details below.

## Principles (§1)

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| P1 | Loops over per-step prompting | ✅ | The unit of work is a loop, not a turn |
| P2 | Dynamic shape > hardcoded personas | ◐ | `compose` generates the workflow from the goal; **no** persona markdown files. But worker/reviewer **seeds are fixed templates** — the agent doesn't construct bespoke sub-agents per task at runtime |
| P3 | Loops may spawn loops | ✅ | Orchestrator → per-piece monitor sub-loops → per-head reviewer threads |
| P4 | Isolation via worktrees | ✅ | Every unit runs in its own `git worktree` |
| P5 | Review before human ("look late") | ✅ | Self-review + commit-landed verification before approval |
| P6 | Prompt yourself out of the loop | ◐ | Delegation ladder rungs 3–7 done; rungs 1–2 (run + verify) not — see below |
| P7 | Subscription economics | ➖ | Documented; the code can't see your billing plan |
| P8 | Bounded autonomy | ✅ | Budgets, caps, divergence, kill-switch |

**Anti-principle respected:** no predefined persona/role library exists. ✅

## Runtime primitives (§3)

| Primitive | Status | Implementation |
|-----------|--------|----------------|
| `spawn_thread(seed)` | ✅ | `ThreadRunner` / `ClaudeCliRunner` |
| `heartbeat(interval, on_wake)` | ✅ | `src/heartbeat.ts` |
| `goal_loop(goal)` | ✅ | `src/loops/goal-loop.ts` (§5C) |
| `worktree(create/teardown)` | ✅ | `WorktreeManager` |
| `run_external(cmd)` | ◐ | `exec()` exists; self-review runs the **same** `claude` CLI, not a distinct agent |
| `computer_use()` | ❌ | **Not implemented.** No browser / dev-server verification |

## Delegation ladder (§4)

| Rung | Action | Status |
|------|--------|--------|
| 1 | Run the dev server | ❌ |
| 2 | Verify the change works (computer use) | ❌ |
| 3 | Commit once verified | ✅ (commit verified to *land*; behavior not verified) |
| 4 | Push & file the PR | ✅ |
| 5 | Collect review-bot comments | ✅ (`fetchComments`, bot heuristic) |
| 6 | Address feedback (spawn reviewer threads) | ✅ |
| 7 | Merge & trigger the next unit | ✅ (orchestrator) |

The ladder is complete from rung 3 on. Rungs 1–2 are the behavioral-verification
gap called out above.

## Canonical loops (§5)

| Loop | Status | Module |
|------|--------|--------|
| 5A Single-PR monitor | ✅ | `single-pr-monitor.ts` — **live-validated** |
| 5B Stacked-PR meta-workflow | ✅ | `orchestrator.ts` + `compose.ts` (goal→definition) |
| 5B setup (decompose, HTML plans, order) | ✅ | `compose.ts`, `plan.ts`, `plan-store.ts` |
| 5C Linear `goal_loop` grinder | ✅ | `goal-loop.ts` |
| 5D Watch / context loops | ◐ | `watch.ts` — observer + diff + notify on deltas; **stdout/log sink only**, no chat |

The §5B "new SHA head → fresh reviewer" heartbeat routine is implemented exactly
as specified. Beyond the spec, the orchestrator also supports a true
**stack-on-parent** mode (dependents branch off the parent's PR branch, nothing
merges mid-run) and retry/partial-resume.

## Workflow generation contract (§6)

| Field | Status |
|-------|--------|
| `goal` | ✅ |
| `pieces[]` (scope, plan ref, worktree) | ✅ |
| dependencies (stacked vs parallel) | ✅ (`dependsOn`, topological waves) |
| per-piece loop (spawn, review trigger, fix-routing, exit) | ✅ (fixed: new-sha / all-approvals) |
| advance rule | ✅ (`merge-pull-next` **and** `stack-on-parent`) |
| heartbeat interval | ✅ |
| budget | ✅ |
| HTML plan approval surface | ✅ |

The per-piece loop fields are **fixed** for the MVP (review on new SHA, exit on
all approvals) rather than freely generated — a reasonable narrowing, not a gap.

## Thread state model (§7)

✅ Implemented in `src/types.ts`, a superset of the spec's `Thread`: it adds the
`watcher` role, the `done`/`halted`/`abandoned` statuses, `killRequested`, a
`loopState` bag (divergence counters, grinder continuation, compacted
resolved-finding ids), and `notes`. The key transition — `headSha` change →
fresh reviewer — is the spine of the monitor. State is durable, atomic, and
concurrency-safe.

## Human-in-the-loop (§8)

✅ The operator is kept in the loop where the spec requires:

- `compose` and `plan` **stop for approval**; nothing runs until you `run`.
- `watch` defaults to **awaiting operator merge** (`--auto-merge` is opt-in).
- Guards **halt and escalate** (status `halted` + `notes`) rather than push
  through.
- "Look late" is enforced: a fix is only accepted after the reviewer pass *and*
  a verified commit.

## Cost & safety (§9)

| Control | Status |
|---------|--------|
| Per-loop token budget | ✅ |
| Per-iteration (heartbeat) cap | ✅ |
| Max wall-clock | ✅ |
| Divergence detection | ✅ |
| Kill-switch | ✅ |
| Blast-radius limit (worktree) | ✅ |
| Subscription-only economic policy | ➖ documented, not enforceable |

## Non-goals & anti-patterns (§10)

| Anti-pattern to avoid | Respected? |
|-----------------------|------------|
| Fully unattended autonomy | ✅ operator at plan + merge gates |
| Production-critical codebases | ✅ documented as out of scope; grinder output flagged experimental |
| Predefined persona/role libraries | ✅ none exist |
| Required custom skills/plugins | ✅ runs on stock `claude` + `gh` |
| Hand copy-pasting bot comments | ✅ `fetchComments` ingests them |

## Rollout order (§11)

All seven steps are implemented: worktree isolation → single-PR monitor →
self-review chaining → HTML plans → stacked-PR meta-workflow → guards →
watch/`goal_loop`.

### Acceptance test

> The operator writes one seed prompt, approves a set of plans, walks away, and
> returns to a reviewed, merged stack of PRs within budget.

**Status: partially demonstrable.** Every stage is built and the §5A path is
proven live, but the *full unattended merge cycle* can't be shown end-to-end on a
single GitHub account: `getPr().mergeable` requires `reviewDecision === "APPROVED"`,
and GitHub forbids approving your own PR. To demonstrate it you need a second
account or an auto-approve bot. Combined with the missing behavioral verification,
treat "walk away and trust the merge" as **not yet earned** — supervise, and lean
on CI checks.

## What the live run found

The §5A path was validated against a real private repo + PR. The in-memory test
fakes pass, but driving real `gh` + `claude` surfaced four defects the fakes
could never catch — a useful reminder of where the trust boundary is:

1. **Non-idempotent worktree attach** — re-running crashed on `already exists`.
2. **No committer identity in worktrees** — unattended `git commit` failed
   silently.
3. **Unverified "resolved" findings** — the monitor trusted the worker's word; it
   now confirms the branch head advanced.
4. **`acceptEdits` blocked Bash** — workers edited but never committed; default
   flipped to `bypassPermissions`.

All four are fixed. The GraphQL review-thread fetch + `resolveReviewThread` path
was likewise validated directly against a live PR.

## Beyond the spec

Hardening the spec didn't ask for, added because the implementation needed it:

- Commit-landed verification (the "look late" check above).
- Finding **compaction** (resolved ids tracked compactly so the findings array
  stays bounded and addressed comments aren't resurrected).
- **Outbound PR acknowledgment + review-thread resolution** (clears
  "require conversation resolution" merge gates).
- **stack-on-parent** advance mode (true stacked PRs).
- Retry/backoff + idempotent **partial resume** of a workflow.
- Durable, concurrency-safe state with a serialized write queue.

## Where to push next

In rough priority:

1. **Behavioral verification** — a `computer_use()` / verify primitive, or at
   minimum a configurable "run tests/build and gate on it" step in the worker
   loop. Closes the single biggest trust gap.
2. **A chat notifier** for §5D (the `Notifier` interface is ready).
3. **A distinct external reviewer** option for `run_external` (a second agent or
   a dedicated review tool) rather than reusing `claude -p`.
4. **A non-self-approval test mode / second-account harness** to demonstrate the
   full §5B acceptance test.
