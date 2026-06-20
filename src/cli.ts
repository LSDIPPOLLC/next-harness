#!/usr/bin/env node
// Operator-facing CLI. The operator's residual job (§4, §8): seed the work,
// approve, and step in for hard calls. These commands cover the MVP rungs:
// worktree isolation, the single-PR monitor loop, and one-shot self-review.

import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_GUARDS, defaultConfig, type HarnessConfig } from "./config.ts";
import { writePlans } from "./plan-store.ts";
import { planOrder, type WorkflowDefinition } from "./plan.ts";
import { Guard } from "./guards.ts";
import { makeLogger } from "./log.ts";
import { StateStore } from "./state-store.ts";
import { GitHubAdapter } from "./adapters/github.ts";
import { WorktreeManager } from "./adapters/worktree.ts";
import { ClaudeCliRunner } from "./adapters/thread-runner.ts";
import { SinglePrMonitor } from "./loops/single-pr-monitor.ts";
import { StackedPrOrchestrator } from "./loops/orchestrator.ts";
import { GoalLoop } from "./loops/goal-loop.ts";
import { WatchLoop, prListObserver } from "./loops/watch.ts";
import { StdoutNotifier } from "./adapters/notifier.ts";
import { composeWorkflow } from "./loops/compose.ts";
import { spawnReviewer } from "./loops/self-review.ts";
import type { Thread } from "./types.ts";

const log = makeLogger("harness");

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const config = defaultConfig(process.cwd());

  switch (command) {
    case "watch":
      return cmdWatch(rest, config);
    case "review":
      return cmdReview(rest, config);
    case "worktree":
      return cmdWorktree(rest, config);
    case "compose":
      return cmdCompose(rest, config);
    case "plan":
      return cmdPlan(rest, config);
    case "run":
      return cmdRun(rest, config);
    case "grind":
      return cmdGrind(rest, config);
    case "watch-prs":
      return cmdWatchPrs(rest, config);
    case "state":
      return cmdState(config);
    case "kill":
      return cmdKill(rest, config);
    case "help":
    case undefined:
      printHelp();
      return 0;
    default:
      log.error(`unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

// harness watch <pr> [--base main] [--auto-merge] [--once]
async function cmdWatch(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "main" },
      "auto-merge": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "permission-mode": { type: "string", default: "bypassPermissions" },
    },
  });
  const prNumber = Number(positionals[0]);
  if (!Number.isInteger(prNumber)) {
    log.error("usage: harness watch <pr> [--base main] [--auto-merge] [--once]");
    return 1;
  }

  const store = await StateStore.open(config.stateDir);
  const gh = new GitHubAdapter(config.repoPath, log);
  const wt = new WorktreeManager(config.repoPath, config.worktreeRoot, log);
  const runner = new ClaudeCliRunner(log, {
    permissionMode: values["permission-mode"] as "acceptEdits",
  });
  const guard = new Guard(config.guards);

  const branch = await gh.getPrBranch(prNumber);
  const worktree = await wt.attach(`pr-${prNumber}`, branch);

  const threadId = `pr-${prNumber}`;
  await store.update((s) => {
    s.threads[threadId] ??= newThread(threadId, worktree.path);
  });

  const monitor = new SinglePrMonitor(
    { gh, runner, guard, store, config, log },
    {
      threadId,
      prNumber,
      worktreePath: worktree.path,
      baseBranch: values.base as string,
      autoMerge: values["auto-merge"] as boolean,
    },
  );

  if (values.once) {
    const result = await monitor.tick();
    log.info(`single tick complete: ${result}`);
    return 0;
  }

  const handle = monitor.start();
  process.on("SIGINT", () => {
    log.warn("SIGINT — stopping loop");
    handle.stop();
  });
  await handle.done;
  log.info("monitor loop finished");
  return 0;
}

// harness review <pr> [--base main]  — one-shot self-review, prints findings
async function cmdReview(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { base: { type: "string", default: "main" } },
  });
  const prNumber = Number(positionals[0]);
  if (!Number.isInteger(prNumber)) {
    log.error("usage: harness review <pr> [--base main]");
    return 1;
  }

  const gh = new GitHubAdapter(config.repoPath, log);
  const wt = new WorktreeManager(config.repoPath, config.worktreeRoot, log);
  const runner = new ClaudeCliRunner(log);

  const branch = await gh.getPrBranch(prNumber);
  const worktree = await wt.attach(`pr-${prNumber}`, branch);
  const pr = await gh.getPr(prNumber);

  const { findings } = await spawnReviewer(
    runner,
    { cwd: worktree.path, baseBranch: values.base as string, headSha: pr.headSha },
    log,
  );
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  return 0;
}

// harness worktree <create|attach|teardown|list> ...
async function cmdWorktree(argv: string[], config: HarnessConfig): Promise<number> {
  const wt = new WorktreeManager(config.repoPath, config.worktreeRoot, log);
  const [sub, name, ...rest] = argv;
  switch (sub) {
    case "create": {
      const { values } = parseArgs({
        args: rest,
        options: { base: { type: "string", default: "main" } },
      });
      if (!name) return usageErr("harness worktree create <name> [--base main]");
      const w = await wt.create(name, values.base as string);
      log.info("created", w);
      return 0;
    }
    case "teardown": {
      const { values } = parseArgs({
        args: rest,
        options: { force: { type: "boolean", default: false } },
      });
      if (!name) return usageErr("harness worktree teardown <name> [--force]");
      await wt.teardown(name, { force: values.force as boolean });
      return 0;
    }
    case "list": {
      const list = await wt.list();
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }
    default:
      return usageErr("harness worktree <create|teardown|list> ...");
  }
}

// harness watch-prs [--once]
// A watch/context loop (§5D): notify on open-PR changes, deltas only.
async function cmdWatchPrs(argv: string[], config: HarnessConfig): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { once: { type: "boolean", default: false } },
  });

  const store = await StateStore.open(config.stateDir);
  const gh = new GitHubAdapter(config.repoPath, log);
  const threadId = "watch-prs";
  await store.update((s) => {
    s.threads[threadId] ??= {
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
  });

  const loop = new WatchLoop(
    {
      observer: prListObserver(gh),
      notifier: new StdoutNotifier(),
      guard: new Guard(config.guards),
      store,
      config,
      log,
    },
    { threadId, name: "open-prs" },
  );

  if (values.once) {
    await loop.tick();
    log.info("watch-prs single check complete");
    return 0;
  }

  const handle = loop.start();
  process.on("SIGINT", () => {
    log.warn("SIGINT — stopping watcher");
    handle.stop();
  });
  await handle.done;
  return 0;
}

// harness grind "<goal>" [--worktree <name>] [--base main] [--here] [--once]
// The linear goal_loop grinder (§5C): one thread grinds a single goal to
// completion in an isolated worktree. Output is experimental by default (§10).
async function cmdGrind(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      worktree: { type: "string", default: "grind" },
      base: { type: "string", default: "main" },
      here: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "permission-mode": { type: "string", default: "bypassPermissions" },
    },
  });
  const goal = positionals.join(" ").trim();
  if (!goal) return usageErr('harness grind "<goal>" [--worktree <name>] [--here] [--once]');

  const store = await StateStore.open(config.stateDir);
  const runner = new ClaudeCliRunner(log, {
    permissionMode: values["permission-mode"] as "acceptEdits",
  });

  // Isolate in a worktree (P4) unless --here runs against the repo directly.
  let worktreePath = config.repoPath;
  if (!values.here) {
    const wt = new WorktreeManager(config.repoPath, config.worktreeRoot, log);
    worktreePath = (await wt.create(values.worktree as string, values.base as string)).path;
  }

  const threadId = `grind-${values.worktree}`;
  await store.update((s) => {
    s.threads[threadId] = newThread(threadId, worktreePath);
  });

  const loop = new GoalLoop(
    { runner, guard: new Guard(config.guards), store, config, log },
    { threadId, goal, worktreePath },
  );

  if (values.once) {
    const result = await loop.tick();
    log.info(`single grind iteration complete: ${result}`);
    return 0;
  }

  const handle = loop.start();
  process.on("SIGINT", () => {
    log.warn("SIGINT — stopping grinder");
    handle.stop();
  });
  await handle.done;
  const final = store.getThread(threadId)?.status ?? "unknown";
  log.info(`grinder finished: ${final}`);
  return final === "done" ? 0 : 1;
}

// harness compose <goal...> [--out <plan.json>] [--permission-mode <mode>]
// Generate a WorkflowDefinition from a goal (§5B setup, P1/P2), then STOP for
// operator approval (§8) — it writes plan.json + HTML plans but never runs.
async function cmdCompose(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "permission-mode": { type: "string", default: "acceptEdits" },
    },
  });
  const goal = positionals.join(" ").trim();
  if (!goal) {
    return usageErr('harness compose "<goal>" [--out plan.json]');
  }

  const runner = new ClaudeCliRunner(log, {
    permissionMode: values["permission-mode"] as "acceptEdits",
  });
  const { ok, def, order, errors, raw } = await composeWorkflow(
    runner,
    {
      goal,
      cwd: config.repoPath,
      heartbeatMs: config.heartbeatMs,
      budget: config.guards,
    },
    log,
  );

  // Always persist the generated definition so the operator can edit + retry.
  const planPath = (values.out as string | undefined) ?? join(config.stateDir, "plan.json");
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(def, null, 2), "utf8");

  if (!ok) {
    log.error("generated definition is not runnable — edit and re-validate", {
      planPath,
    });
    for (const e of errors) log.error(`  - ${e}`);
    log.debug("raw generator output", { raw });
    return 1;
  }

  const written = await writePlans(def, join(config.stateDir, "plans"), log);
  log.info("composed workflow — review before running (§8)", {
    order: order.join(" -> "),
  });
  process.stdout.write(
    `\nGenerated plan: ${planPath}\nApproval surface: ${written.indexPath}\n` +
      `Review it, then run:\n  node src/cli.ts run ${planPath}\n`,
  );
  return 0;
}

// harness plan <plan.json> [--out <dir>]   |   harness plan --example
// Renders the §6 workflow definition into an HTML approval surface (§8).
async function cmdPlan(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      example: { type: "boolean", default: false },
    },
  });

  if (values.example) {
    process.stdout.write(`${JSON.stringify(exampleDefinition(), null, 2)}\n`);
    return 0;
  }

  const file = positionals[0];
  if (!file) {
    return usageErr("harness plan <plan.json> [--out <dir>]  |  harness plan --example");
  }

  const def = await loadDefinition(file);
  if (!def) return 1;
  const { ok, order, errors } = planOrder(def);
  if (!ok) {
    for (const e of errors) {
      log.error(`${e.pieceId ? `[${e.pieceId}] ` : ""}${e.message}`);
    }
    return 1;
  }

  const plansDir = (values.out as string | undefined) ?? join(config.stateDir, "plans");
  const written = await writePlans(def, plansDir, log);
  log.info("plans written", { order: order.join(" -> "), index: written.indexPath });
  process.stdout.write(`${written.indexPath}\n`);
  return 0;
}

function exampleDefinition(): WorkflowDefinition {
  return {
    goal: "Add rate limiting to the public API",
    heartbeatMs: 7 * 60 * 1000,
    budget: { ...DEFAULT_GUARDS },
    reviewTrigger: "new-sha",
    exitCondition: "all-approvals",
    advanceRule: "merge-pull-next",
    pieces: [
      {
        id: "limiter-core",
        scope: "Token-bucket limiter module with unit tests.",
        worktreeName: "limiter-core",
        dependsOn: [],
      },
      {
        id: "middleware",
        scope: "Wire the limiter into the request middleware.",
        worktreeName: "middleware",
        dependsOn: ["limiter-core"],
      },
      {
        id: "metrics",
        scope: "Emit throttle metrics (parallel with middleware).",
        worktreeName: "metrics",
        dependsOn: ["limiter-core"],
      },
    ],
  };
}

// harness run <plan.json> [--base main]
// Execute a workflow definition through the §5B stacked-PR orchestrator.
async function cmdRun(argv: string[], config: HarnessConfig): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "main" },
      stacked: { type: "boolean", default: false },
      "permission-mode": { type: "string", default: "bypassPermissions" },
    },
  });
  const file = positionals[0];
  if (!file) return usageErr("harness run <plan.json> [--base main] [--stacked]");

  const def = await loadDefinition(file);
  if (!def) return 1;
  // --stacked overrides the plan's advance rule for true stacked PRs (§5B):
  // dependents branch off their parent's branch and nothing merges mid-run.
  if (values.stacked) def.advanceRule = "stack-on-parent";
  const { ok, errors } = planOrder(def);
  if (!ok) {
    for (const e of errors) log.error(e.message);
    return 1;
  }

  const store = await StateStore.open(config.stateDir);
  const orchestrator = new StackedPrOrchestrator(
    {
      gh: new GitHubAdapter(config.repoPath, log),
      runner: new ClaudeCliRunner(log, {
        permissionMode: values["permission-mode"] as "acceptEdits",
      }),
      worktrees: new WorktreeManager(config.repoPath, config.worktreeRoot, log),
      store,
      config,
      log,
    },
    def,
  );

  const outcomes = await orchestrator.run({ baseBranch: values.base as string });
  process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
  const allMerged = outcomes.every((o) => o.status === "merged");
  return allMerged ? 0 : 1;
}

async function cmdState(config: HarnessConfig): Promise<number> {
  const store = await StateStore.open(config.stateDir);
  process.stdout.write(`${JSON.stringify(store.snapshot(), null, 2)}\n`);
  return 0;
}

// harness kill <threadId>  — request a clean stop honored at the next tick
async function cmdKill(argv: string[], config: HarnessConfig): Promise<number> {
  const threadId = argv[0];
  if (!threadId) return usageErr("harness kill <threadId>");
  const store = await StateStore.open(config.stateDir);
  if (!store.getThread(threadId)) {
    log.error(`no such thread: ${threadId}`);
    return 1;
  }
  await store.update((s) => {
    const t = s.threads[threadId];
    if (t) {
      t.killRequested = true;
      t.notes.push("kill requested by operator");
    }
  });
  log.info(`kill requested for ${threadId}; honored at next heartbeat`);
  return 0;
}

function newThread(id: string, worktree: string): Thread {
  return {
    id,
    role: "worker",
    worktree,
    pieceId: null,
    pr: null,
    status: "implementing",
    lastReviewedSha: null,
    killRequested: false,
    budget: { tokensUsed: 0, iterations: 0, startedAt: Date.now() },
    notes: [],
  };
}

function usageErr(msg: string): number {
  log.error(`usage: ${msg}`);
  return 1;
}

/**
 * Read + parse a workflow definition with friendly errors instead of a fatal
 * stack. Returns null (and logs why) on a missing file or malformed JSON.
 */
async function loadDefinition(file: string): Promise<WorkflowDefinition | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    log.error(`cannot read plan file: ${file}`);
    return null;
  }
  try {
    return JSON.parse(raw) as WorkflowDefinition;
  } catch (e) {
    log.error(`plan file is not valid JSON: ${file}`, {
      detail: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function printHelp(): void {
  process.stdout.write(
    `next-harness — dynamic loop orchestration for Claude Code

Usage:
  harness watch <pr> [--base main] [--auto-merge] [--once] [--permission-mode <mode>]
        Run the single-PR monitor loop (§5A): watch a PR, self-review on each
        new head, address bot/human/reviewer findings, until approved or a
        guard trips. --once runs a single heartbeat (good for cron/testing).

  harness review <pr> [--base main]
        One-shot self-review: spawn a fresh reviewer thread on the PR's diff
        and print findings as JSON.

  harness worktree create <name> [--base main]
  harness worktree teardown <name> [--force]
  harness worktree list
        Manage isolated worktrees (§3, P4).

  harness compose "<goal>" [--out plan.json]
        Generate a workflow definition from a goal (§5B setup, P1/P2): an agent
        inspects the repo, decomposes the goal into ordered pieces, and writes
        plan.json + HTML plans. Stops for approval — does NOT run (§8).

  harness plan <plan.json> [--out <dir>]
  harness plan --example
        Render a §6 workflow definition into an HTML approval surface (§8):
        one skimmable plan per piece + an index. --example prints a starter
        definition to stdout.

  harness run <plan.json> [--base main] [--stacked]
        Execute a workflow through the §5B stacked-PR orchestrator: per piece,
        implement -> file PR -> review sub-loop -> merge -> advance. Pieces in a
        wave run concurrently; waves are a barrier. --stacked builds true
        stacked PRs: each dependent branches off its parent's PR branch and
        nothing merges mid-run (operator merges the approved stack bottom-up).

  harness grind "<goal>" [--worktree <name>] [--base main] [--here] [--once]
        Linear goal_loop grinder (§5C): one thread grinds a single goal to
        completion in an isolated worktree (--here uses the repo directly).
        Output is experimental by default. --once runs one iteration.

  harness watch-prs [--once]
        Watch/context loop (§5D): notify on open-PR changes (new, updated,
        closed), deltas only. Notifications go to stdout. --once checks once.

  harness state            Dump persisted harness state (§7 threads + findings).
  harness kill <threadId>  Request a clean stop, honored at the next heartbeat.
  harness help             This message.
`,
  );
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error("fatal", { error: err instanceof Error ? err.stack : String(err) });
    process.exit(1);
  });
