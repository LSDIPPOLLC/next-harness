---
title: Home
layout: default
nav_order: 1
---

# next-harness
{: .fs-9 }

Dynamic loop orchestration for Claude Code — **design loops that prompt agents**
instead of prompting agents step by step.
{: .fs-6 .fw-300 }

[Get started](getting-started){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[Spec mapping & gaps](spec-gaps){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## The idea

The operator's job shifts from *writing every prompt* to *seeding the work and
designing the loop that carries it*. Two ideas do most of the work:

1. **The shape of the loop comes from the shape of the problem.** You give the
   orchestrator a goal; it decomposes the goal into a plan, files the PRs,
   reviews itself, fixes what review finds, and advances — loops can create loops.
2. **The human looks late.** Machine review runs *before* a human reads the code.
   Reading agent output before a reviewer has passed over it is wasted time.

next-harness is the runtime that makes those two ideas concrete. It is an
**outer loop that drives the `claude` CLI headlessly**: each unit of work runs as
a spawned Claude Code agent inside an isolated git worktree, on a heartbeat,
under hard budget guards.

## What it does, in one screen

```bash
# 1. Decompose a goal into an ordered, reviewable plan (stops for your approval)
harness compose "add rate limiting to the public API"

# 2. Skim the generated HTML plans, then run the stacked-PR orchestrator
harness run .harness/plan.json

# …or watch a single existing PR until it's review-clean
harness watch 123

# …or grind one long linear task to completion in its own worktree
harness grind "port the test suite from mocha to node:test"
```

Each of those is a **loop**, not a prompt. It wakes on a heartbeat, reads PR
state, spawns a fresh reviewer on every new commit, routes findings back to a
worker that commits and pushes, resolves the review threads it fixed, and stops
when the work is approved or a guard trips.

## The four canonical loops

| Loop | Command | What it's for |
|------|---------|---------------|
| **Single-PR monitor** (§5A) | `harness watch <pr>` | Keep one PR review-clean, unattended |
| **Stacked-PR meta-workflow** (§5B) | `harness compose` → `run` | Ship work too big for one PR as an ordered stack |
| **Linear `goal_loop` grinder** (§5C) | `harness grind "<goal>"` | One long track with nothing to parallelize |
| **Watch / context loop** (§5D) | `harness watch-prs` | Bring information to you; notify on deltas |

See [Concepts](concepts) for the mental model, the [CLI reference](cli-reference)
for every command, and [Recipes](recipes) for end-to-end walkthroughs.

## Status

All four loop shapes plus the cross-cutting machinery (state model, guards,
pluggable adapters) are implemented and tested. The single-PR path is validated
live against a real GitHub repo + PR. The honest accounting of what matches the
[original spec](spec-gaps) and what doesn't — most notably **behavioral
verification** (does the change actually *work*, not just compile) — lives on the
[Spec mapping & gaps](spec-gaps) page. Read it before you trust a loop with
anything you can't afford to have broken.

{: .note }
> next-harness keeps an operator at the plan-approval and merge gates by design.
> It is **not** fully unattended autonomy — loops get budgets, caps, and a
> kill-switch, and you approve the plan before anything runs.
