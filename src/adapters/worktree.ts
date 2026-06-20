// Runtime primitive: worktree(create / teardown).  §3, Principle P4.
// Isolation via worktrees is the foundation (rollout step 1): each unit of
// work lives in its own checkout so it never blocks other work and can be
// abandoned cleanly. Nothing else in the harness is safe without this.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../exec.ts";
import type { Logger } from "../log.ts";

export interface Worktree {
  /** Branch checked out in the worktree. */
  branch: string;
  /** Absolute path to the isolated checkout. */
  path: string;
}

export class WorktreeManager {
  private readonly repoPath: string;
  private readonly root: string;
  private readonly log: Logger;

  constructor(repoPath: string, root: string, log: Logger) {
    this.repoPath = repoPath;
    this.root = root;
    this.log = log.child("worktree");
  }

  /**
   * Create an isolated worktree on a fresh branch off `baseBranch`.
   * Idempotent-ish: if the branch already exists it is reused.
   */
  async create(name: string, baseBranch = "main"): Promise<Worktree> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, name);
    const branch = `harness/${name}`;

    // Re-running a command must not crash on an existing checkout: if git
    // already tracks a worktree at this path, reuse it.
    const existing = await this.existingAt(path);
    if (existing) {
      await this.ensureIdentity(path);
      this.log.info(`reusing existing worktree`, { name, path, branch: existing.branch });
      return existing;
    }

    // Make sure our view of the base is current before branching. Branching
    // off origin/<base> is the "pull latest main" step (§5B advance rule):
    // each new worktree starts from the freshly fetched remote base.
    await exec("git", ["fetch", "origin", baseBranch], {
      cwd: this.repoPath,
      rejectOnError: false,
    });
    const startPoint = await this.resolveBase(baseBranch);

    const branchExists =
      (
        await exec("git", ["rev-parse", "--verify", "--quiet", branch], {
          cwd: this.repoPath,
          rejectOnError: false,
        })
      ).code === 0;

    const args = branchExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, startPoint];

    await exec("git", args, { cwd: this.repoPath });
    await this.ensureIdentity(path);
    this.log.info(`created worktree`, { name, branch, path });
    return { branch, path };
  }

  /**
   * Attach an isolated worktree to an EXISTING branch (e.g. a PR's head
   * branch), creating a local tracking branch if needed. Used by the
   * single-PR monitor loop (§5A) to work on a PR already on the host.
   */
  async attach(name: string, branch: string): Promise<Worktree> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, name);

    // Idempotent re-attach: a prior command (e.g. `review`) may have left this
    // worktree in place. Reuse it rather than failing on "already exists".
    const existing = await this.existingAt(path);
    if (existing) {
      await this.ensureIdentity(path);
      this.log.info(`reusing existing worktree`, { name, branch, path });
      return { branch, path };
    }

    await exec("git", ["fetch", "origin", branch], {
      cwd: this.repoPath,
      rejectOnError: false,
    });

    const localExists =
      (
        await exec("git", ["rev-parse", "--verify", "--quiet", branch], {
          cwd: this.repoPath,
          rejectOnError: false,
        })
      ).code === 0;

    const args = localExists
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`];

    await exec("git", args, { cwd: this.repoPath });
    await this.ensureIdentity(path);
    this.log.info(`attached worktree to existing branch`, { name, branch, path });
    return { branch, path };
  }

  /**
   * Unattended workers commit on their own; git refuses to commit without an
   * author identity. If none is configured, set a local one so a fix worker's
   * `git commit` never fails silently. Overridable via HARNESS_GIT_NAME/EMAIL.
   */
  private async ensureIdentity(path: string): Promise<void> {
    const email = (
      await exec("git", ["config", "user.email"], { cwd: path, rejectOnError: false })
    ).stdout.trim();
    if (email) return;
    const name = process.env.HARNESS_GIT_NAME ?? "next-harness";
    const addr = process.env.HARNESS_GIT_EMAIL ?? "harness@localhost";
    await exec("git", ["config", "user.name", name], { cwd: path });
    await exec("git", ["config", "user.email", addr], { cwd: path });
    this.log.info("set local git identity for unattended commits", { path, name, addr });
  }

  /** Tear down a worktree. `force` discards uncommitted changes (abandon). */
  async teardown(name: string, opts: { force?: boolean } = {}): Promise<void> {
    const path = join(this.root, name);
    const args = ["worktree", "remove", path];
    if (opts.force) args.push("--force");
    await exec("git", args, { cwd: this.repoPath, rejectOnError: false });
    this.log.info(`tore down worktree`, { name, forced: !!opts.force });
  }

  /** Prefer the freshly fetched remote base; fall back to the local ref. */
  private async resolveBase(baseBranch: string): Promise<string> {
    const remote = `origin/${baseBranch}`;
    const hasRemote =
      (
        await exec("git", ["rev-parse", "--verify", "--quiet", remote], {
          cwd: this.repoPath,
          rejectOnError: false,
        })
      ).code === 0;
    return hasRemote ? remote : baseBranch;
  }

  /** The worktree git already tracks at `path`, if any (makes re-runs safe). */
  private async existingAt(path: string): Promise<Worktree | undefined> {
    return (await this.list()).find((w) => w.path === path);
  }

  /** List worktrees git currently tracks, porcelain-parsed. */
  async list(): Promise<Worktree[]> {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: this.repoPath,
    });
    const out: Worktree[] = [];
    let path = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) {
        out.push({ path, branch: line.slice("branch refs/heads/".length) });
      }
    }
    return out;
  }
}
