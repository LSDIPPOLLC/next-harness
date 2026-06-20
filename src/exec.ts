// Promise wrapper around child_process for the adapters. Captures stdout/stderr,
// never inherits the parent shell, and surfaces non-zero exits as rejections.

import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd?: string;
  /** Hard timeout in ms; the child is killed on breach. */
  timeoutMs?: number;
  /** Extra env on top of process.env. */
  env?: Record<string, string>;
  /** Reject on non-zero exit (default true). */
  rejectOnError?: boolean;
}

export async function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs, env, rejectOnError = true } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: ExecResult = { stdout, stderr, code: code ?? -1 };
      if (timedOut) {
        reject(new Error(`\`${cmd}\` timed out after ${timeoutMs}ms`));
        return;
      }
      if (rejectOnError && result.code !== 0) {
        reject(
          new Error(
            `\`${cmd} ${args.join(" ")}\` exited ${result.code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}
