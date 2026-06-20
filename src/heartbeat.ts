// Runtime primitive: heartbeat(interval, on_wake).  §3.
// Wakes on a fixed interval and runs a state-advancement routine. The routine
// returns whether the loop is done; when done, the heartbeat stops itself.
// Wakes never overlap: a slow routine simply delays the next tick.

import type { Logger } from "./log.ts";

export type WakeResult = "continue" | "done";

export interface HeartbeatHandle {
  /** Stop scheduling further wakes. */
  stop(): void;
  /** Resolves when the loop reaches "done" or is stopped. */
  done: Promise<void>;
}

export function heartbeat(
  intervalMs: number,
  onWake: () => Promise<WakeResult>,
  log: Logger,
): HeartbeatHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));
  const hb = log.child("heartbeat");

  const finish = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    resolveDone();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await onWake();
      if (result === "done") {
        hb.info("loop reported done");
        finish();
        return;
      }
    } catch (err) {
      // A failing wake must not kill the loop; log and try again next tick.
      hb.error("wake threw, will retry next tick", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  // Fire the first wake immediately so the loop starts working at once.
  queueMicrotask(tick);

  return { stop: finish, done };
}
