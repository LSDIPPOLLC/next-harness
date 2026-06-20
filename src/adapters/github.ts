// Adapter for the PR host. Uses the `gh` CLI so we never plumb tokens
// ourselves; `gh` infers owner/repo from the checkout it runs in.
// Implements the "collect review-bot comments" rung of the delegation
// ladder (§4) so the operator never copy-pastes comments by hand.

import { exec } from "../exec.ts";
import type { Logger } from "../log.ts";
import type { PrState } from "../types.ts";

export interface PrComment {
  /** Stable id used to dedupe across heartbeats. */
  id: string;
  author: string;
  body: string;
  /** Heuristic: did a review bot or a human write this? */
  isBot: boolean;
  /** "file:line" when it's a review comment, else "general". */
  area: string;
  /**
   * GraphQL node id of the review thread, for inline review comments only.
   * Used to resolve the thread once the comment is addressed.
   */
  threadId?: string;
}

interface GhReview {
  state: string;
  author?: { login: string };
}

interface GhPrView {
  number: number;
  headRefOid: string;
  mergeable: string; // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  reviewDecision: string | null; // "APPROVED" | "CHANGES_REQUESTED" | ...
  statusCheckRollup: Array<{ state?: string; conclusion?: string }> | null;
  reviews: GhReview[];
}

const BOT_HINT = /\b(bot|coderabbit|macroscope|sonarcloud|codecov|github-actions)\b/i;

export class GitHubAdapter {
  private readonly repoPath: string;
  private readonly log: Logger;

  constructor(repoPath: string, log: Logger) {
    this.repoPath = repoPath;
    this.log = log.child("github");
  }

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await exec("gh", args, {
      cwd: this.repoPath,
      timeoutMs: 60_000,
    });
    return stdout;
  }

  /** Read PR state into the §7 PrState shape. */
  async getPr(number: number): Promise<PrState> {
    const raw = await this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "number,headRefOid,mergeable,reviewDecision,statusCheckRollup,reviews",
    ]);
    const v = JSON.parse(raw) as GhPrView;

    const approvals = v.reviews.filter((r) => r.state === "APPROVED").length;
    const checks = rollupChecks(v.statusCheckRollup);
    const mergeable =
      v.mergeable === "MERGEABLE" &&
      v.reviewDecision === "APPROVED" &&
      checks !== "FAILURE";

    return {
      number: v.number,
      headSha: v.headRefOid,
      checks,
      approvals,
      mergeable,
    };
  }

  /**
   * Fetch issue comments + inline review comments, normalized. This is the
   * signal the worker loop reacts to (§5A step 2).
   *
   * Inline comments come via GraphQL (not REST) so each carries its review
   * thread's node id and resolution state: we key the finding on the thread,
   * skip threads already resolved, and can resolve the thread once we fix it.
   */
  async fetchComments(number: number): Promise<PrComment[]> {
    const repo = await this.repoSlug();
    const out: PrComment[] = [];

    // Inline review threads (carry file + line + thread id). Only unresolved
    // threads are actionable; the first comment is the original review note.
    for (const thread of await this.reviewThreads(repo, number)) {
      if (thread.isResolved) continue;
      const first = thread.comments[0];
      if (!first) continue;
      out.push({
        id: `review:${thread.id}`,
        author: first.author,
        body: first.body,
        isBot: BOT_HINT.test(first.author),
        area: first.path ? `${first.path}:${first.line ?? "?"}` : "general",
        threadId: thread.id,
      });
    }

    // Top-level issue comments (review-bot summaries, human notes).
    const issue = JSON.parse(
      await this.gh([
        "api",
        `repos/${repo}/issues/${number}/comments`,
        "--paginate",
      ]),
    ) as Array<{ id: number; user: { login: string }; body: string }>;
    for (const c of issue) {
      out.push({
        id: `issue:${c.id}`,
        author: c.user.login,
        body: c.body,
        isBot: BOT_HINT.test(c.user.login),
        area: "general",
      });
    }

    return out;
  }

  /** List open PRs with the fields a watch loop (§5D) diffs across heartbeats. */
  async listOpenPrs(): Promise<
    Array<{
      number: number;
      title: string;
      headSha: string;
      reviewDecision: string | null;
      updatedAt: string;
    }>
  > {
    const raw = await this.gh([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,headRefOid,reviewDecision,updatedAt",
    ]);
    const list = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      headRefOid: string;
      reviewDecision: string | null;
      updatedAt: string;
    }>;
    return list.map((p) => ({
      number: p.number,
      title: p.title,
      headSha: p.headRefOid,
      reviewDecision: p.reviewDecision,
      updatedAt: p.updatedAt,
    }));
  }

  /** The PR's head branch name — used to check out a worktree on it. */
  async getPrBranch(number: number): Promise<string> {
    const raw = await this.gh([
      "pr",
      "view",
      String(number),
      "--json",
      "headRefName",
    ]);
    return (JSON.parse(raw) as { headRefName: string }).headRefName;
  }

  /**
   * Open a PR for an already-pushed branch and return its number. Used by the
   * orchestrator (§5B) when a worker has filed a fresh piece.
   */
  async createPr(
    head: string,
    base: string,
    title: string,
    body: string,
  ): Promise<number> {
    const { stdout } = await exec(
      "gh",
      ["pr", "create", "--head", head, "--base", base, "--title", title, "--body", body],
      { cwd: this.repoPath, timeoutMs: 60_000 },
    );
    const m = stdout.match(/\/pull\/(\d+)/);
    if (!m) {
      // Fallback: the branch may already have a PR; look it up.
      const raw = await this.gh(["pr", "view", head, "--json", "number"]);
      return (JSON.parse(raw) as { number: number }).number;
    }
    const number = Number(m[1]);
    this.log.info(`opened PR`, { number, head });
    return number;
  }

  async postComment(number: number, body: string): Promise<void> {
    await this.gh(["pr", "comment", String(number), "--body", body]);
    this.log.info(`posted comment`, { number });
  }

  /**
   * Fetch the PR's review threads via GraphQL: node id, resolution state, and
   * the first comment's author/body/location. REST exposes comments but not
   * their thread or its resolution state, which we need to resolve threads.
   */
  private async reviewThreads(
    repo: string,
    number: number,
  ): Promise<
    Array<{
      id: string;
      isResolved: boolean;
      comments: Array<{ author: string; body: string; path?: string; line?: number }>;
    }>
  > {
    const [owner, name] = repo.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{
              id
              isResolved
              comments(first:1){ nodes{ body path line author{ login } } }
            }
          }
        }
      }
    }`;
    const raw = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]);
    const parsed = JSON.parse(raw) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id: string;
                isResolved: boolean;
                comments?: {
                  nodes?: Array<{
                    body: string;
                    path?: string;
                    line?: number;
                    author?: { login?: string };
                  }>;
                };
              }>;
            };
          };
        };
      };
    };
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    if (nodes.length === 100) {
      this.log.warn("review-thread page is full (100) — older threads may be truncated", {
        number,
      });
    }
    return nodes.map((n) => ({
      id: n.id,
      isResolved: n.isResolved,
      comments: (n.comments?.nodes ?? []).map((c) => ({
        author: c.author?.login ?? "unknown",
        body: c.body,
        path: c.path,
        line: c.line,
      })),
    }));
  }

  /** Resolve a review thread (clears the "conversation resolution" merge gate). */
  async resolveReviewThread(threadId: string): Promise<void> {
    const mutation = `mutation($threadId:ID!){
      resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
    }`;
    await this.gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `threadId=${threadId}`]);
    this.log.info(`resolved review thread`, { threadId });
  }

  /** Merge once policy allows. Squash by default. */
  async merge(number: number): Promise<void> {
    await this.gh(["pr", "merge", String(number), "--squash", "--delete-branch"]);
    this.log.info(`merged PR`, { number });
  }

  private async repoSlug(): Promise<string> {
    const raw = await this.gh([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
    ]);
    return (JSON.parse(raw) as { nameWithOwner: string }).nameWithOwner;
  }
}

function rollupChecks(
  rollup: Array<{ state?: string; conclusion?: string }> | null,
): string | null {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const c of rollup) {
    const s = (c.conclusion || c.state || "").toUpperCase();
    if (s === "FAILURE" || s === "ERROR" || s === "CANCELLED") return "FAILURE";
    if (s === "" || s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED") {
      pending = true;
    }
  }
  return pending ? "PENDING" : "SUCCESS";
}
