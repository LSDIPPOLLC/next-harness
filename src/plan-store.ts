// Rollout step 4: HTML plans + approval surface.  §6, §2 (HTML Plan Store).
// Writes one skimmable, mobile-friendly plan per piece plus an index, so the
// operator can review and approve the *definition* on any device before the
// loop runs (§8). Approval of the definition replaces approval of each step.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./log.ts";
import {
  planOrder,
  planWaves,
  type Piece,
  type WorkflowDefinition,
} from "./plan.ts";

export interface WrittenPlans {
  dir: string;
  indexPath: string;
  /** piece id -> html path. */
  pieces: Record<string, string>;
}

/**
 * Render and write the full plan set. Throws if the definition is invalid —
 * an unapprovable plan should never reach disk silently.
 */
export async function writePlans(
  def: WorkflowDefinition,
  plansDir: string,
  log: Logger,
): Promise<WrittenPlans> {
  const { ok, order, errors } = planOrder(def);
  if (!ok) {
    throw new Error(
      `invalid workflow definition:\n${errors
        .map((e) => `  - ${e.pieceId ? `[${e.pieceId}] ` : ""}${e.message}`)
        .join("\n")}`,
    );
  }
  const waves = planWaves(def, order);

  await mkdir(plansDir, { recursive: true });
  const byId = new Map(def.pieces.map((p) => [p.id, p]));
  const pieces: Record<string, string> = {};

  for (const p of def.pieces) {
    const file = join(plansDir, `${p.id}.html`);
    p.planRef = file;
    pieces[p.id] = file;
  }
  for (const p of def.pieces) {
    await writeFile(join(plansDir, `${p.id}.html`), renderPiece(def, p), "utf8");
  }

  const indexPath = join(plansDir, "index.html");
  await writeFile(indexPath, renderIndex(def, order, waves, byId), "utf8");

  log.child("plans").info(`wrote ${def.pieces.length} plan(s) + index`, {
    dir: plansDir,
  });
  return { dir: plansDir, indexPath, pieces };
}

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:1.25rem;max-width:46rem;margin-inline:auto}
h1{font-size:1.4rem;margin:.2rem 0 1rem}
h2{font-size:1.1rem;margin:1.4rem 0 .4rem}
.chip{display:inline-block;font-size:.75rem;padding:.1rem .5rem;border-radius:1rem;background:#8884;margin:0 .25rem .25rem 0}
.card{border:1px solid #8883;border-radius:.6rem;padding:.8rem 1rem;margin:.6rem 0}
.muted{opacity:.7;font-size:.85rem}
a{color:inherit}
ol{padding-left:1.2rem}
code{background:#8882;padding:.05rem .3rem;border-radius:.3rem}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>\n`;
}

function renderPiece(def: WorkflowDefinition, p: Piece): string {
  const deps = p.dependsOn.length
    ? p.dependsOn.map((d) => `<span class="chip">after ${esc(d)}</span>`).join("")
    : `<span class="chip">no prerequisites — parallelizable</span>`;
  const body = `
<p class="muted"><a href="index.html">&larr; all pieces</a></p>
<h1>${esc(p.id)}</h1>
<p>${esc(p.scope)}</p>
<div>${deps}</div>
<div class="card">
  <h2>Per-piece loop</h2>
  <ol>
    <li>Spawn a worker thread in worktree <code>${esc(p.worktreeName)}</code>.</li>
    <li>File the PR.</li>
    <li>Review trigger: <strong>${esc(def.reviewTrigger)}</strong> — a fresh reviewer per new SHA head.</li>
    <li>Route findings back; re-review after fixes.</li>
    <li>Exit: <strong>${esc(def.exitCondition)}</strong>.</li>
    <li>Advance: <strong>${esc(def.advanceRule)}</strong>.</li>
  </ol>
</div>
<div class="card">
  <h2>Budget (§9)</h2>
  <p class="muted">max ${def.budget.maxTokens.toLocaleString()} tokens ·
  ${def.budget.maxWorkPerHeartbeat} fixes/wake ·
  ${Math.round(def.budget.maxWallClockMs / 3_600_000)}h wall-clock ·
  divergence at ${def.budget.divergenceThreshold}× ·
  heartbeat ${Math.round(def.heartbeatMs / 60_000)}m</p>
</div>`;
  return page(`${p.id} — plan`, body);
}

function renderIndex(
  def: WorkflowDefinition,
  order: string[],
  waves: string[][],
  byId: Map<string, Piece>,
): string {
  const waveHtml = waves
    .map((wave, i) => {
      const items = wave
        .map((id) => {
          const p = byId.get(id)!;
          return `<div class="card"><a href="${esc(id)}.html"><strong>${esc(id)}</strong></a>
<div class="muted">${esc(p.scope)}</div></div>`;
        })
        .join("");
      const label =
        wave.length > 1 ? `Wave ${i + 1} — parallel` : `Wave ${i + 1}`;
      return `<h2>${label}</h2>${items}`;
    })
    .join("");
  const body = `
<h1>${esc(def.goal)}</h1>
<p class="muted">${def.pieces.length} piece(s) · execution order:
${order.map(esc).join(" &rarr; ")}</p>
<p class="muted">Approve this definition to authorize the loop (§8). Each card links to its plan.</p>
${waveHtml}`;
  return page(def.goal, body);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
