import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeJson, ClaudeCliRunner } from "../src/adapters/thread-runner.ts";
import { makeLogger } from "../src/log.ts";

process.env.HARNESS_LOG = "silent";
const log = makeLogger("test");

// --- parseClaudeJson fixtures: the shapes the `claude` CLI can emit ---

test("parses a single result object with usage", () => {
  const out = parseClaudeJson(
    '{"type":"result","is_error":false,"result":"done","usage":{"output_tokens":123,"input_tokens":5}}',
  );
  assert.equal(out?.is_error, false);
  assert.equal(out?.result, "done");
  assert.equal(out?.usage?.output_tokens, 123);
});

test("parses stream-json: takes the last parseable line", () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant"}',
    '{"type":"result","result":"ok","usage":{"output_tokens":7}}',
  ].join("\n");
  const out = parseClaudeJson(stream);
  assert.equal(out?.result, "ok");
  assert.equal(out?.usage?.output_tokens, 7);
});

test("preserves is_error", () => {
  const out = parseClaudeJson('{"is_error":true,"result":"refused"}');
  assert.equal(out?.is_error, true);
});

test("returns null on empty or non-JSON output", () => {
  assert.equal(parseClaudeJson(""), null);
  assert.equal(parseClaudeJson("   "), null);
  assert.equal(parseClaudeJson("I could not comply."), null);
});

// --- integration: drive ClaudeCliRunner against a stub binary ---

async function makeStub(stdout: string, exitCode = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-stub-"));
  const path = join(dir, "claude-stub.sh");
  // Ignores all args; just emits canned output and exits with a chosen code.
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

test("ClaudeCliRunner maps a successful run to ok + text + tokensUsed", async () => {
  const bin = await makeStub(
    '{"is_error":false,"result":"made the change","usage":{"output_tokens":42}}',
  );
  const runner = new ClaudeCliRunner(log, { bin });
  const cwd = await mkdtemp(join(tmpdir(), "harness-cwd-"));

  const r = await runner.run("do the thing", { cwd });
  assert.equal(r.ok, true);
  assert.equal(r.text, "made the change");
  assert.equal(r.tokensUsed, 42);
});

test("ClaudeCliRunner reports is_error results as not ok", async () => {
  const bin = await makeStub('{"is_error":true,"result":"blocked"}');
  const runner = new ClaudeCliRunner(log, { bin });
  const cwd = await mkdtemp(join(tmpdir(), "harness-cwd-"));

  const r = await runner.run("x", { cwd });
  assert.equal(r.ok, false);
  assert.equal(r.text, "blocked");
});

test("ClaudeCliRunner handles a nonzero exit with no stdout", async () => {
  const bin = await makeStub("", 1);
  const runner = new ClaudeCliRunner(log, { bin });
  const cwd = await mkdtemp(join(tmpdir(), "harness-cwd-"));

  const r = await runner.run("x", { cwd });
  assert.equal(r.ok, false);
  assert.equal(r.tokensUsed, 0);
});
