// Tolerant JSON extraction from agent output. Models often wrap the JSON we
// asked for in prose or code fences; this pulls out the outermost array or
// object and parses it. Shared by self-review (findings array) and the
// workflow generator (definition object).

export type JsonKind = "array" | "object";

/**
 * Extract and parse the first top-level JSON value of `kind` from `text`.
 * Returns null if none is found or it doesn't parse. The caller validates
 * shape — this only locates and parses.
 */
export function extractJson(text: string, kind: JsonKind): unknown | null {
  const [open, close] = kind === "array" ? ["[", "]"] : ["{", "}"];
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
