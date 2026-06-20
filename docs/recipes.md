---
title: Recipes
layout: default
nav_order: 5
---

# Recipes
{: .no_toc }

End-to-end walkthroughs for the common workflows.
{: .fs-6 .fw-300 }

<details open markdown="block">
  <summary>On this page</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## Keep one PR review-clean, unattended

You have an open PR and want the harness to keep addressing review feedback
until it's clean.

```bash
cd /path/to/repo
harness watch 42                 # heartbeat every 7 min, stops for you to merge
```

What happens each tick: a fresh reviewer runs on the current head, bot/human
comments are folded in, each finding gets a worker that commits + pushes, the
fixed review threads are resolved, and a summary comment is posted. It stops when
the PR is approved + clean, or a guard trips.

- Add `--auto-merge` to squash-merge as soon as it's mergeable.
- Run it under cron with `--once` instead of leaving a process up:

```bash
*/10 * * * * cd /path/to/repo && harness watch 42 --once >> harness.log 2>&1
```

- Stop it cleanly: `harness kill pr-42`.

## Ship a goal as a stack of PRs

The flagship loop. Three steps: compose, approve, run.

```bash
# 1. Generate the plan (stops for approval — runs no work)
harness compose "add request rate limiting with metrics"

# 2. Review the plans a human can skim
open .harness/plans/index.html     # macOS; use xdg-open on Linux

# 3a. Execute, merging each piece before dependents start
harness run .harness/plan.json

# 3b. …or as true stacked PRs (nothing merges until you do, bottom-up)
harness run .harness/plan.json --stacked
```

If a piece fails partway, just re-run `harness run …` — completed pieces are
skipped (partial resume); only unfinished work is redone.

### Hand-writing or editing a plan

`compose` is optional. You can author the definition yourself:

```bash
harness plan --example > plan.json     # starter definition
$EDITOR plan.json                      # edit pieces / dependsOn
harness plan plan.json                 # validate + render HTML
harness run plan.json
```

A `pieces[].dependsOn` entry of `["a"]` means "stacked under a". In default mode
`a` must merge first; in `--stacked` mode the piece branches off `a`'s PR branch.
Stacked mode requires a linear chain (≤ 1 dependency per piece) and is rejected
otherwise at validation time.

## Grind one long linear task

For a migration or rewrite with nothing to parallelize:

```bash
harness grind "convert all CommonJS requires to ES module imports"
```

Each turn the agent reports whether it's done and what's next; the loop feeds
that back and halts if it stops making progress. Use `--here` to work in the repo
directly (no worktree), or `--once` for a single iteration.

{: .note }
> Grinder output is **experimental by default** (spec §10). Review it like any
> other branch before relying on it.

## Watch PRs across a repo and get notified

```bash
harness watch-prs                 # notifies on new / updated / closed PRs
harness watch-prs --once          # one check (cron-friendly)
```

Notifications go to stdout today. To route them elsewhere (a chat channel),
implement the `Notifier` interface — see
[Architecture → Add a notifier](architecture#add-a-notifier). A chat sink is a
[known gap](spec-gaps#5d--watch--context-loops).

## Drive the harness from inside Claude Code

Because the harness is just a CLI, you can ask Claude Code to run it — the
harness then spawns its own child agents:

> "Run `harness compose 'add a /healthz endpoint'`, show me the plan, and if it
> looks reasonable, `harness run` it."

This is loops-creating-loops in practice: your interactive Claude Code session is
the operator, and the harness it invokes runs the unattended sub-loops.

## Recover from a stuck or runaway loop

```bash
harness state                     # see thread status, tokens, what's open
harness kill <threadId>           # clean stop at next heartbeat
```

If a loop `halted` on divergence, its `notes` explain why. Worktrees for
abandoned work can be cleaned up with `harness worktree teardown <name> --force`.
