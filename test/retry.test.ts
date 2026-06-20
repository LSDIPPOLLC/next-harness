import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.ts";

const noSleep = () => Promise.resolve();

test("returns immediately on first success", async () => {
  let calls = 0;
  const out = await retry(
    async () => {
      calls++;
      return "ok";
    },
    { attempts: 3, sleep: noSleep },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("retries transient failures then succeeds", async () => {
  let calls = 0;
  const retried: number[] = [];
  const out = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return calls;
    },
    { attempts: 3, sleep: noSleep, onRetry: (_e, n) => retried.push(n) },
  );
  assert.equal(out, 3);
  assert.equal(calls, 3);
  assert.deepEqual(retried, [2, 3]);
});

test("throws the last error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { attempts: 2, sleep: noSleep },
      ),
    /fail-2/,
  );
  assert.equal(calls, 2);
});
