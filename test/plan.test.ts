import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planOrder, planWaves, type WorkflowDefinition } from "../src/plan.ts";
import { writePlans } from "../src/plan-store.ts";
import { makeLogger } from "../src/log.ts";
import { DEFAULT_GUARDS } from "../src/config.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

function def(pieces: WorkflowDefinition["pieces"]): WorkflowDefinition {
  return {
    goal: "G",
    heartbeatMs: 420_000,
    budget: { ...DEFAULT_GUARDS },
    reviewTrigger: "new-sha",
    exitCondition: "all-approvals",
    advanceRule: "merge-pull-next",
    pieces,
  };
}

test("planOrder topologically sorts stacked pieces", () => {
  const d = def([
    { id: "c", scope: "", worktreeName: "c", dependsOn: ["b"] },
    { id: "b", scope: "", worktreeName: "b", dependsOn: ["a"] },
    { id: "a", scope: "", worktreeName: "a", dependsOn: [] },
  ]);
  const { ok, order } = planOrder(d);
  assert.equal(ok, true);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("stacked mode rejects a piece with more than one dependency", () => {
  const d: WorkflowDefinition = {
    ...def([
      { id: "a", scope: "", worktreeName: "a", dependsOn: [] },
      { id: "b", scope: "", worktreeName: "b", dependsOn: [] },
      { id: "c", scope: "", worktreeName: "c", dependsOn: ["a", "b"] },
    ]),
    advanceRule: "stack-on-parent",
  };
  const { ok, errors } = planOrder(d);
  assert.equal(ok, false);
  assert.ok(
    errors.some((e) => e.pieceId === "c" && /linear chain/.test(e.message)),
    "flags the multi-dependency piece",
  );
});

test("a linear chain is valid in stacked mode", () => {
  const d: WorkflowDefinition = {
    ...def([
      { id: "a", scope: "", worktreeName: "a", dependsOn: [] },
      { id: "b", scope: "", worktreeName: "b", dependsOn: ["a"] },
    ]),
    advanceRule: "stack-on-parent",
  };
  const { ok, order } = planOrder(d);
  assert.equal(ok, true);
  assert.deepEqual(order, ["a", "b"]);
});

test("planWaves groups independent pieces for parallel execution", () => {
  const d = def([
    { id: "core", scope: "", worktreeName: "core", dependsOn: [] },
    { id: "mw", scope: "", worktreeName: "mw", dependsOn: ["core"] },
    { id: "metrics", scope: "", worktreeName: "metrics", dependsOn: ["core"] },
  ]);
  const { order } = planOrder(d);
  const waves = planWaves(d, order);
  assert.deepEqual(waves[0], ["core"]);
  assert.deepEqual(new Set(waves[1]), new Set(["mw", "metrics"]));
});

test("planOrder reports a dependency cycle", () => {
  const d = def([
    { id: "a", scope: "", worktreeName: "a", dependsOn: ["b"] },
    { id: "b", scope: "", worktreeName: "b", dependsOn: ["a"] },
  ]);
  const { ok, errors } = planOrder(d);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.message.includes("cycle")));
});

test("planOrder reports dangling, self, and duplicate ids", () => {
  const d = def([
    { id: "a", scope: "", worktreeName: "a", dependsOn: ["ghost"] },
    { id: "a", scope: "", worktreeName: "a2", dependsOn: ["a"] },
    { id: "c", scope: "", worktreeName: "c", dependsOn: ["c"] },
  ]);
  const { ok, errors } = planOrder(d);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.message.includes("unknown piece")));
  assert.ok(errors.some((e) => e.message.includes("duplicate")));
  assert.ok(errors.some((e) => e.message.includes("itself")));
});

test("writePlans emits index + per-piece html and escapes content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plan-"));
  const d = def([
    { id: "x", scope: "guard <script> & inject", worktreeName: "x", dependsOn: [] },
  ]);
  const written = await writePlans(d, dir, log);
  const index = await readFile(written.indexPath, "utf8");
  const piece = await readFile(written.pieces["x"]!, "utf8");
  assert.ok(index.includes("<!doctype html>"));
  assert.ok(piece.includes("&lt;script&gt;"), "user content is HTML-escaped");
  assert.ok(!piece.includes("<script>"), "no raw injection");
});

test("writePlans throws on an invalid definition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plan-"));
  const d = def([
    { id: "a", scope: "", worktreeName: "a", dependsOn: ["b"] },
    { id: "b", scope: "", worktreeName: "b", dependsOn: ["a"] },
  ]);
  await assert.rejects(() => writePlans(d, dir, log), /invalid workflow definition/);
});
