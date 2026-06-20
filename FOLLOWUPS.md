# Followups

Running action list for the self-paced build loop. Newest decisions at top of
each section. Mark `[x]` when done; leave a one-line note on why if dropped.

> **Milestone:** all canonical loop shapes (§5A–§5D) are implemented. Remaining
> work is hardening, not new loop shapes.

## Next up (priority order)

- [ ] **Full §5B / stacked merge cycle against a multi-account repo.** The §5A
  path is now validated live (see Done), but a run-to-merge can't be exercised
  on a single GitHub account: `getPr().mergeable` requires
  `reviewDecision === "APPROVED"`, and GitHub forbids approving your own PR. To
  prove the orchestrator advance + auto-merge + bottom-up stacked merge live,
  point it at a repo where a second account (or an auto-approve bot) can approve
  — or add a `--no-approval-required` test mode that treats mergeable as
  checks-only. Until then the orchestrator's primitives are individually
  live-validated and the advance/stack logic is unit-tested.

- [x] ~~**Vestigial `ReviewFinding.resolved` field.**~~ Dropped the field, the
  dead `tallyAreas` helper (its only real consumer), and the always-true
  `.filter(f => !f.resolved)` / `.some(...)` it fed. The findings array holds
  only open items by construction now.

- [x] ~~**Stacked (non-merge) PR mode.**~~ Built. `advanceRule:
  "stack-on-parent"` (or `run --stacked`): each dependent's worktree + PR branch
  off its parent's PR branch (`harness/<parent.worktreeName>`), the monitor
  sub-loops never auto-merge, and the wave barrier advances on **approved**
  instead of merged. `planOrder` rejects non-linear stacks (≤1 dependency per
  piece). Resume skips already-approved pieces. 4 tests (2 orchestrator behavior
  + 2 plan validation).

## Surfaced / tech debt

- [x] ~~**`parseClaudeJson` fixture test.**~~ Done: `test/thread-runner.test.ts`
  covers single-object, stream-json (last line), `is_error`, and empty/garbage
  shapes, plus 3 integration tests driving `ClaudeCliRunner` against a stub
  binary (success/error/nonzero-exit) — exercising the full exec→parse→token
  path. Guards token accounting against CLI format drift.
- [ ] **Real PR integration test.** Faked-adapter tests can't cover `gh` JSON
  shape drift or push/PR-create edge cases. A recorded-fixture test against
  captured `gh` output would help; a true live `watch`/`run` is the real proof
  (blocked here — no remote).
- [x] ~~Divergence counter per-process~~ → persisted to `loopState.touchCounts`.
- [x] ~~CLI dir-exists guard (ENOENT on writes)~~ → `StateStore.open` now
  `mkdir`s the state dir; `compose` already `mkdir`s its out dir.
- [x] ~~Bad/malformed plan file throws a fatal stack~~ → `loadDefinition`
  reports a friendly error + exit 1 (`plan`/`run`).
- [x] ~~Test logger noise from child loggers~~ → `HARNESS_LOG=silent` honored in
  `emit()`; all test files set it.

## Done

- [x] **Outbound PR acknowledgment + review-thread resolution.** The review
  workflow was inbound-only (`postComment` existed but was never called); the
  monitor now closes the loop on the PR. After a tick's fixes land it resolves
  each inline review thread it addressed (GraphQL `resolveReviewThread`, so
  "require conversation resolution" branch protection actually clears) and posts
  one summary "addressed in `<sha>`" comment. Inline comments are now fetched via
  GraphQL so each finding carries its thread node id; already-resolved threads
  are skipped. All acks are best-effort (a comment/resolve hiccup never undoes a
  verified fix). 2 new monitor tests; query + mutation + the full adapter path
  validated **live** against a real PR's inline thread.
  - Caveat: `reviewThreads(first:100)` isn't paginated — logs a warning if a PR
    has >100 threads. Fine for the MVP; paginate if it ever bites.

- [x] **Live §5A shakedown against a real GitHub repo + PR** (private
  `ldippo/harness-shakedown`). Drove `review`, `watch --once`, and `watch-prs`
  against an actual open PR; reviewer found planted issues, workers committed +
  pushed real commits, verified end to end. Surfaced and fixed **four** real
  defects the fakes couldn't reach:
  - [x] **Non-idempotent worktree attach/create** — a second command crashed on
    `git worktree add ... already exists`. Now reuses an existing worktree at the
    path (`WorktreeManager.existingAt`).
  - [x] **No committer identity in worktrees** — unattended `git commit` failed
    silently. `ensureIdentity` sets a local identity (env-overridable) on
    create/attach, including the reuse path.
  - [x] **Unverified "resolved" findings** — the monitor trusted the worker's
    `ok` and marked findings resolved even when no commit landed. Now confirms
    the worktree HEAD advanced before resolving (`readHead`, injectable); a
    no-op worker leaves the finding open to re-touch → divergence. 1 new test.
  - [x] **`acceptEdits` blocked git** — the decisive find. `acceptEdits`
    auto-approves edits but gates Bash, so headless workers edited without
    committing. Default flipped to `bypassPermissions` for the unattended loops
    (`watch`/`grind`/`run` + the runner), justified by worktree blast-radius.
  - Limitation: full §5B/stacked merge cycle not reachable solo (can't approve
    own PR) — moved to "Next up".

- [x] Step 1 — worktree isolation (`src/adapters/worktree.ts`).
- [x] Step 2 — single-PR monitor loop §5A (`src/loops/single-pr-monitor.ts`).
- [x] Step 3 — self-review chaining (`src/loops/self-review.ts`).
- [x] Step 4 — HTML plans + approval surface §6 (`src/plan.ts`, `src/plan-store.ts`).
- [x] Step 5 — §5B stacked-PR orchestrator (`src/loops/orchestrator.ts`):
  waves with within-wave concurrency + between-wave barrier; per-piece
  implement → file PR → review sub-loop → auto-merge → advance.
  - [x] `GitHubAdapter.createPr` (via `gh pr create`, parses PR # from URL).
  - [x] "Pull latest main": `WorktreeManager.create` now branches off the
    freshly fetched `origin/<base>` (falls back to local ref offline).
  - [x] **Bug fixed:** `StateStore.update` was not concurrency-safe — parallel
    pieces in a wave raced on the `state.json.tmp` rename (ENOENT). Now
    serialized through a write queue + pid-unique temp file. Surfaced by the
    new orchestrator parallel-wave test.
- [x] **Goal → definition generation (§5B setup, P1/P2)** — `src/loops/compose.ts`
  + `harness compose "<goal>"`. Agent inspects the repo, decomposes the goal
  into ordered pieces; coerced + validated via `planOrder`; writes plan.json +
  HTML plans and stops for approval (§8). Shared tolerant JSON extraction
  factored into `src/parse-json.ts` (self-review now uses it too).
  - [x] **Verified live** against this repo: real `claude -p` run produced a
    valid, sensibly-ordered 2-piece stacked plan (helpers → CLI wiring).
  - [x] **Bug fixed:** `compose` wrote `.harness/plan.json` before the dir
    existed (ENOENT) — now `mkdir(dirname)` first.
- [x] **Step 7a — linear `goal_loop` grinder (§5C)** — `src/loops/goal-loop.ts`
  + `harness grind "<goal>"`. One thread grinds a goal in an isolated worktree
  (`--here` to use the repo directly); each turn the agent self-reports
  `{done, summary, next}`, the loop feeds `next` back as "where you left off",
  and halts on a no-progress streak (the §9 divergence analog for linear work).
  Added a `done` terminal status to the thread model. 5 tests.
  - Note (test semantics): the first turn sets the no-progress baseline and is
    never "stalled", so `divergenceThreshold = N` needs N+1 identical turns to
    halt. A fresh summary resets the streak. Captured in the reset test.
- [x] **Step 7b — watch/context loops (§5D)** — `src/loops/watch.ts` +
  `src/adapters/notifier.ts` + `harness watch-prs`. Heartbeat + an injected
  `Observer` + a pluggable `Notifier`; diffs each observation against a
  last-seen digest in state (new `HarnessState.watch` map) and notifies only on
  deltas (new / updated / gone). Ships `prListObserver` (open-PR watcher) and a
  `StdoutNotifier`/`LogNotifier`. Added `watcher` thread role. 5 tests.
  - Not yet run live — needs a repo with a GitHub remote (see "Next up").
- [x] Cross-cutting: §7 state model, §9 guards, §3 primitive adapters.

- [x] **Hardening: persist loop decision state across restarts** —
  `Thread.loopState` (`src/types.ts`) carries `goal_loop`'s
  `lastNext`/`lastSummary`/`noProgress` and the monitor's `touchCounts`. Both
  loops hydrate once on the first tick and persist after each cycle, so a
  `--once` cron cadence or a process restart resumes the streak/counters
  instead of silently resetting them. 2 restart-proof tests.
- [x] **Hardening: CLI robustness** — friendly errors on bad plan files
  (`loadDefinition`), `StateStore.open` guarantees the state dir, and
  `HARNESS_LOG=silent` quiets runs/tests (child loggers included).
- [x] **Hardening: finding compaction** — the monitor now drops a resolved
  finding from `findings[]` and records its id in
  `loopState.resolvedFindingIds`; `mergeFindings` skips both existing and
  resolved ids, so the array stays bounded (only unresolved items) while a
  re-fetched bot comment is never resurrected. 2 tests (compaction + no-resurrect).
- [x] **Hardening: orchestrator retry + partial resume** — `src/retry.ts`
  (bounded retry, linear backoff, injectable sleep). The implement and
  file-PR steps retry before abandoning a piece; `runPiece` skips a piece whose
  thread is already `merged`, so re-running a workflow only redoes what didn't
  land. 5 tests (3 retry-util + retry + partial-resume). This also addresses
  the "all-or-nothing wave advance" concern: a re-run resumes past merged work.

---

**All §11 canonical loop shapes complete (§5A, §5B + goal→def gen, §5C, §5D),
plus stacked-no-merge mode and outbound PR acks.** Test count: 59, all passing;
typecheck clean.
§5A is live-validated end to end (four real defects found + fixed). The only
remaining item needs infrastructure this environment can't provide: a second
GitHub account / auto-approve bot to drive the §5B merge cycle to completion.
