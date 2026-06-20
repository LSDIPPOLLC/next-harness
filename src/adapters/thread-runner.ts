// Runtime primitives: spawn_thread(seed) and run_external(cmd).  §3.
// A ThreadRunner turns a seed prompt into agent work inside a worktree and
// reports token usage back so the Guard (§9) can enforce budgets.
//
// The interface is deliberately pluggable: today it shells out to the
// `claude` CLI in headless mode; an Agent-SDK runner could drop in later
// without touching the loops.

import { exec } from "../exec.ts";
import type { Logger } from "../log.ts";
import type { ThreadResult } from "../types.ts";

export interface RunOptions {
  /** Worktree to run in — the unit's isolated checkout (P4). */
  cwd: string;
  /** Upper bound on this single turn, in ms. */
  timeoutMs?: number;
  /** Label for logs. */
  label?: string;
}

export interface ThreadRunner {
  run(seed: string, opts: RunOptions): Promise<ThreadResult>;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  subtype?: string;
  usage?: { output_tokens?: number; input_tokens?: number };
}

export interface ClaudeCliOptions {
  /** Binary to invoke (overridable for tests). */
  bin?: string;
  /**
   * Permission posture for unattended runs. The loops fundamentally need to run
   * Bash (`git commit`, `git push`) with no human to approve it; "acceptEdits"
   * auto-approves file edits but still gates Bash, so a worker would silently
   * edit-without-committing. All loop work is confined to an isolated worktree
   * (the blast-radius limit, §9/P4), which is exactly the justification for
   * bypassing — so the default is "bypassPermissions". Narrow it for read-only
   * uses (e.g. self-review) where no commit is needed.
   */
  permissionMode?: "acceptEdits" | "bypassPermissions" | "plan" | "default";
  /** Optional model override. */
  model?: string;
}

export class ClaudeCliRunner implements ThreadRunner {
  private readonly bin: string;
  private readonly permissionMode: string;
  private readonly model: string | undefined;
  private readonly log: Logger;

  constructor(log: Logger, opts: ClaudeCliOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.permissionMode = opts.permissionMode ?? "bypassPermissions";
    this.model = opts.model;
    this.log = log.child("runner");
  }

  async run(seed: string, opts: RunOptions): Promise<ThreadResult> {
    const args = [
      "-p",
      seed,
      "--output-format",
      "json",
      "--permission-mode",
      this.permissionMode,
    ];
    if (this.model) args.push("--model", this.model);

    this.log.info(`spawn thread`, { label: opts.label, cwd: opts.cwd });
    const { stdout, stderr, code } = await exec(this.bin, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
      rejectOnError: false,
    });

    if (code !== 0 && !stdout.trim()) {
      return { ok: false, text: stderr.trim() || `exit ${code}`, tokensUsed: 0 };
    }

    const parsed = parseClaudeJson(stdout);
    if (!parsed) {
      // Fell back to raw text — still usable, just no token accounting.
      return { ok: code === 0, text: stdout.trim(), tokensUsed: 0, raw: stderr };
    }
    return {
      ok: !parsed.is_error,
      text: parsed.result ?? "",
      tokensUsed: parsed.usage?.output_tokens ?? 0,
      raw: parsed,
    };
  }
}

export function parseClaudeJson(stdout: string): ClaudeJsonResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeJsonResult;
  } catch {
    // The CLI may emit a stream of JSON lines; take the last parseable one.
    const lines = trimmed.split("\n").reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line) as ClaudeJsonResult;
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}
