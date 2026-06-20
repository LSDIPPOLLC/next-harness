// Notification sink for watch/context loops (§5D, §2). Pluggable like
// ThreadRunner: today it routes to stdout or the log; a chat/push adapter
// (PushNotification, Slack, etc.) drops in without touching the loop.

import type { Logger } from "../log.ts";

export interface Notifier {
  notify(message: string): Promise<void>;
}

/** Writes notifications to stdout, set apart so they stand out in a terminal. */
export class StdoutNotifier implements Notifier {
  async notify(message: string): Promise<void> {
    process.stdout.write(`\n🔔 ${message}\n`);
  }
}

/** Routes notifications through the structured logger (for unattended runs). */
export class LogNotifier implements Notifier {
  private readonly log: Logger;
  constructor(log: Logger) {
    this.log = log.child("notify");
  }
  async notify(message: string): Promise<void> {
    this.log.info(message);
  }
}
