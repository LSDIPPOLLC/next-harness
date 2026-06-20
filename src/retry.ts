// Bounded retry with linear backoff for transient failures (e.g. a flaky `gh`
// call or a runner hiccup) before the orchestrator gives up on a piece (§9:
// abandon, don't spin forever). The sleep is injectable so tests don't wait.

export interface RetryOptions {
  /** Total attempts, including the first. Must be >= 1. */
  attempts: number;
  /** Base delay; attempt N waits delayMs * N. */
  delayMs?: number;
  /** Called before each retry (not the final failure). */
  onRetry?: (err: unknown, nextAttempt: number) => void;
  /** Overridable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying on any thrown error up to `attempts` times. */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts, delayMs = 1000, onRetry, sleep = realSleep } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        onRetry?.(err, attempt + 1);
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastErr;
}
