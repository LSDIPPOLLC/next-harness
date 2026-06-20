// Minimal structured logger. Loops run for hours unattended, so every
// state-advancing decision is logged with a thread tag for later audit.

type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, tag: string, msg: string, extra?: unknown): void {
  // HARNESS_LOG=silent fully quiets output (tests, scripted runs). Read at
  // emit time so it can be toggled per process before the first log.
  if (process.env.HARNESS_LOG === "silent") return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] (${tag}) ${msg}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (extra !== undefined) {
    stream.write(`${line} ${JSON.stringify(extra)}\n`);
  } else {
    stream.write(`${line}\n`);
  }
}

export function makeLogger(tag: string) {
  return {
    info: (msg: string, extra?: unknown) => emit("info", tag, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", tag, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", tag, msg, extra),
    debug: (msg: string, extra?: unknown) => {
      if (process.env.HARNESS_DEBUG) emit("debug", tag, msg, extra);
    },
    child: (sub: string) => makeLogger(`${tag}:${sub}`),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
