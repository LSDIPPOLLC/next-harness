import { test } from "node:test";
import assert from "node:assert/strict";
import { Guard } from "../src/guards.ts";
import type { GuardLimits } from "../src/config.ts";
import type { BudgetState } from "../src/types.ts";

const limits: GuardLimits = {
  maxTokens: 1000,
  maxWorkPerHeartbeat: 2,
  maxWallClockMs: 10_000,
  divergenceThreshold: 3,
};

const budget = (over: Partial<BudgetState> = {}): BudgetState => ({
  tokensUsed: 0,
  iterations: 0,
  startedAt: 0,
  ...over,
});

test("checkBudget passes when within all limits", () => {
  const g = new Guard(limits);
  const v = g.checkBudget(budget({ tokensUsed: 500 }), 5_000);
  assert.equal(v.ok, true);
});

test("checkBudget trips on tokens", () => {
  const g = new Guard(limits);
  const v = g.checkBudget(budget({ tokensUsed: 1000 }), 0);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "tokens");
});

test("checkBudget trips on wall-clock", () => {
  const g = new Guard(limits);
  const v = g.checkBudget(budget({ startedAt: 0 }), 10_000);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "wallclock");
});

test("kill-switch trips immediately", () => {
  const g = new Guard(limits);
  g.kill();
  const v = g.checkBudget(budget(), 0);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "killed");
});

test("withinHeartbeatBudget caps per-wake work", () => {
  const g = new Guard(limits);
  assert.equal(g.withinHeartbeatBudget(0), true);
  assert.equal(g.withinHeartbeatBudget(1), true);
  assert.equal(g.withinHeartbeatBudget(2), false);
});

test("detectDivergence trips at threshold", () => {
  const g = new Guard(limits);
  assert.equal(g.detectDivergence(new Map([["a.ts:1", 2]])).ok, true);
  const v = g.detectDivergence(new Map([["a.ts:1", 3]]));
  assert.equal(v.ok, false);
  assert.equal(v.reason, "divergence");
});
