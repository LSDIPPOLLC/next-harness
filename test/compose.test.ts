import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/parse-json.ts";
import { composeWorkflow } from "../src/loops/compose.ts";
import { makeLogger } from "../src/log.ts";
import { DEFAULT_GUARDS } from "../src/config.ts";
import type { ThreadRunner, RunOptions } from "../src/adapters/thread-runner.ts";
import type { ThreadResult } from "../src/types.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

function runnerReturning(text: string, ok = true): ThreadRunner {
  return {
    async run(_seed: string, _o: RunOptions): Promise<ThreadResult> {
      return { ok, text, tokensUsed: 42 };
    },
  };
}

const params = {
  goal: "Add rate limiting",
  cwd: "/repo",
  heartbeatMs: 420_000,
  budget: { ...DEFAULT_GUARDS },
};

test("extractJson pulls an object out of surrounding prose and fences", () => {
  const text = 'Here is the plan:\n```json\n{"goal":"x","pieces":[]}\n```\nDone.';
  const obj = extractJson(text, "object") as { goal: string };
  assert.equal(obj.goal, "x");
});

test("extractJson returns null when no value of the kind is present", () => {
  assert.equal(extractJson("no json here", "object"), null);
  assert.equal(extractJson("{not valid", "object"), null);
});

test("composeWorkflow builds a valid definition and fills fixed fields", async () => {
  const gen = JSON.stringify({
    goal: "Add rate limiting to the API",
    pieces: [
      { id: "core", scope: "limiter", worktreeName: "core", dependsOn: [] },
      { id: "mw", scope: "middleware", dependsOn: ["core"] },
    ],
  });
  const res = await composeWorkflow(runnerReturning(`thinking...\n${gen}`), params, log);

  assert.equal(res.ok, true);
  assert.deepEqual(res.order, ["core", "mw"]);
  assert.equal(res.def.reviewTrigger, "new-sha");
  assert.equal(res.def.exitCondition, "all-approvals");
  assert.equal(res.def.advanceRule, "merge-pull-next");
  assert.equal(res.def.heartbeatMs, params.heartbeatMs);
  // worktreeName defaults to id when omitted.
  assert.equal(res.def.pieces[1]!.worktreeName, "mw");
});

test("composeWorkflow surfaces validation errors (cycle) without crashing", async () => {
  const gen = JSON.stringify({
    goal: "g",
    pieces: [
      { id: "a", scope: "", worktreeName: "a", dependsOn: ["b"] },
      { id: "b", scope: "", worktreeName: "b", dependsOn: ["a"] },
    ],
  });
  const res = await composeWorkflow(runnerReturning(gen), params, log);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("cycle")));
});

test("composeWorkflow drops malformed pieces and fails when none remain", async () => {
  const gen = JSON.stringify({ pieces: [{ scope: "no id" }, 42, null] });
  const res = await composeWorkflow(runnerReturning(gen), params, log);
  assert.equal(res.ok, false);
  assert.equal(res.def.pieces.length, 0);
  assert.ok(res.errors.some((e) => e.includes("no usable pieces")));
  // Falls back to the requested goal when the generator omits it.
  assert.equal(res.def.goal, params.goal);
});

test("composeWorkflow reports a failed generator run", async () => {
  const res = await composeWorkflow(runnerReturning("boom", false), params, log);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("generator run failed")));
});

test("composeWorkflow reports non-JSON output", async () => {
  const res = await composeWorkflow(runnerReturning("I could not do it."), params, log);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("did not emit a JSON object")));
});
