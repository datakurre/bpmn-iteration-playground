import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SessionDetail, TurnRecord } from "../studio/types.ts";
import {
  formatTurnRange,
  renderSessionDiagrams,
  renderSessionSvg,
  renderToSvg,
  renderSessionPng,
  renderToPng,
  renderSessionPngDataUri,
  renderSessionSvgDataUri,
  renderToPngDataUri,
  renderToSvgDataUri,
} from "../js/lib/bpmn-to-image/render.ts";
import { SessionStore } from "../agent/session-store.ts";
import { requirePaths } from "./main.ts";

export interface ActivitySummary {
  activityId: string;
  activityName: string;
  harness: string;
  turns: number;
  turnIndices: number[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  costUSD: number;
  durationMs: number;
}

export function computeActivitySummaries(turns: TurnRecord[]): ActivitySummary[] {
  const map = new Map<string, ActivitySummary>();
  for (const turn of turns) {
    const existing = map.get(turn.activityId) || {
      activityId: turn.activityId,
      activityName: turn.activityName || turn.activityId,
      harness: turn.harness || "-",
      turns: 0,
      turnIndices: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
      durationMs: 0,
    };
    existing.turns += 1;
    existing.turnIndices.push(turn.index);
    if (turn.usage) {
      existing.inputTokens += turn.usage.input || 0;
      existing.outputTokens += turn.usage.output || 0;
      existing.cacheReadTokens += turn.usage.cacheRead || 0;
      existing.reasoningTokens += turn.usage.reasoning || 0;
      existing.costUSD += turn.usage.cost?.total || 0;
    }
    if (turn.startedAt && turn.endedAt) {
      existing.durationMs += turn.endedAt - turn.startedAt;
    }
    map.set(turn.activityId, existing);
  }
  return [...map.values()];
}

function formatCost(usd: number): string {
  if (!usd || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function generateMarkdownReport(
  detail: SessionDetail,
  options: { embedSvg?: boolean; embedDataUri?: boolean; imageFormat?: "png" | "svg"; scale?: number } = {}
): Promise<string> {
  const stats = detail.stats;
  const activities = computeActivitySummaries(detail.turns);
  const totalCost = stats?.totalCostUSD ? formatCost(stats.totalCostUSD) : "$0.00";
  const totalTokens = stats?.totalTokens ? formatTokens(stats.totalTokens) : "0";
  const cacheHit = stats?.cacheHitRatio !== undefined ? `${Math.round(stats.cacheHitRatio * 100)}%` : "0%";

  let totalDurationMs = 0;
  for (const t of detail.turns) {
    if (t.startedAt && t.endedAt) totalDurationMs += t.endedAt - t.startedAt;
  }
  const durationStr = totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : "-";

  let promptSection = "";
  if (detail.prompt) {
    promptSection = `\n## Task Prompt\n\n> ${detail.prompt.replace(/\n/g, "\n> ")}\n`;
  }

  let diagramSection = "";
  if (options.embedDataUri || options.embedSvg) {
    try {
      const rendered = await renderSessionDiagrams(detail, {
        showCostBadges: true,
        background: "#ffffff",
        includePngDataUri: options.imageFormat !== "svg",
        scale: options.scale ?? 2,
      });

      if (rendered.length > 0) {
        diagramSection = `\n## Execution Diagram${rendered.length > 1 ? "s" : ""}\n\n`;
        for (const diag of rendered) {
          const title = diag.isRoot ? `### ${diag.name} (Root Workflow)` : `### Subprocess: ${diag.name}`;
          if (options.embedDataUri) {
            const uri = options.imageFormat === "svg"
              ? `data:image/svg+xml;base64,${Buffer.from(diag.svg).toString("base64")}`
              : (diag.pngDataUri || `data:image/svg+xml;base64,${Buffer.from(diag.svg).toString("base64")}`);
            diagramSection += `${title}\n\n![${diag.name}](${uri})\n\n`;
          } else if (options.embedSvg) {
            diagramSection += `${title}\n\n\`\`\`xml\n${diag.svg}\n\`\`\`\n\n`;
          }
        }
      }
    } catch {
      // Fallback
    }
  }

  let activityTable = "| Activity | Symbol | Harness | Turns | In / Out / Cache | Reasoning | Cost ($ USD) | Duration |\n";
  activityTable += "| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |\n";
  for (const act of activities) {
    const symbol = formatTurnRange(act.turnIndices) || "-";
    const tokens = `${formatTokens(act.inputTokens)} / ${formatTokens(act.outputTokens)} / ${formatTokens(act.cacheReadTokens)}`;
    const dur = act.durationMs > 0 ? `${(act.durationMs / 1000).toFixed(1)}s` : "-";
    activityTable += `| \`${act.activityId}\` | \`${symbol}\` | \`${act.harness}\` | ${act.turns} | ${tokens} | ${formatTokens(act.reasoningTokens)} | ${formatCost(act.costUSD)} | ${dur} |\n`;
  }

  let turnLog = "\n## Chronological Turn Log\n\n";
  if (detail.turns.length === 0) {
    turnLog += "_No turns executed._\n";
  } else {
    for (const turn of detail.turns) {
      const toolList = turn.toolCalls?.length ? turn.toolCalls.map((t) => `\`${t}\``).join(", ") : "-";
      const tokens = turn.usage
        ? `in: ${turn.usage.input}, out: ${turn.usage.output}, cacheRead: ${turn.usage.cacheRead}`
        : "-";
      const cost = turn.usage?.cost?.total ? formatCost(turn.usage.cost.total) : "$0.00";
      const stopReason = turn.stopReason ? ` (${turn.stopReason})` : "";

      turnLog += `### [T${turn.index}] Turn ${turn.index}: ${turn.activityName || turn.activityId}${stopReason}\n\n`;
      turnLog += `- **Activity**: \`${turn.activityId}\` (\`${turn.harness || "-"}\`)\n`;
      turnLog += `- **Tokens & Cost**: ${tokens} · **${cost}**\n`;
      turnLog += `- **Tools Called**: ${toolList}\n`;
      if (turn.summary) {
        turnLog += `\n**Response Summary**:\n> ${turn.summary.replace(/\n/g, "\n> ")}\n\n`;
      }
      if (turn.error) {
        turnLog += `\n> ⚠️ **Error**: ${turn.error}\n\n`;
      }
    }
  }

  let revisionsLog = "";
  if (detail.revisions.length > 0) {
    revisionsLog = "\n## Graph Revisions\n\n";
    for (const rev of detail.revisions) {
      const added = rev.addedElementIds.length ? ` (+${rev.addedElementIds.join(", ")})` : "";
      revisionsLog += `- **r${rev.index}** (${new Date(rev.at).toLocaleTimeString()}): ${rev.reason}${added}\n`;
    }
  }

  let errorSection = "";
  if (detail.harnessError) {
    errorSection = `\n> ⚠️ **Harness Error**: ${detail.harnessError}\n`;
  }

  return `# Session Report: ${detail.name || detail.id}

- **Session ID**: \`${detail.id}\`
- **Status**: \`${detail.status}\`
- **Model**: \`${detail.model || "default"}\`
- **Total Cost**: **${totalCost}**
- **Turns**: ${detail.turnCount}
- **Total Tokens**: ${totalTokens} (${cacheHit} cache hit)
- **Duration**: ${durationStr}
- **Project**: \`${detail.project}\`
${errorSection}${promptSection}${diagramSection}
## Activity Breakdown

${activityTable}
${turnLog}${revisionsLog}
`;
}

export async function generateHtmlReport(
  detail: SessionDetail,
  options: { imageFormat?: "png" | "svg" | "raw-svg"; scale?: number } = {}
): Promise<string> {
  const format = options.imageFormat || "png";
  let diagramCardsHtml = "";

  try {
    const rendered = await renderSessionDiagrams(detail, {
      showCostBadges: true,
      background: "#ffffff",
      includePngDataUri: format === "png",
      scale: options.scale ?? 2,
    });

    if (rendered.length === 0) {
      diagramCardsHtml = `<p class="text-muted">Diagram preview unavailable.</p>`;
    } else {
      diagramCardsHtml = rendered
        .map((diag, idx) => {
          const title = diag.isRoot ? `${escapeHtml(diag.name)} (Root Process)` : `Subprocess: ${escapeHtml(diag.name)}`;
          const badge = diag.turnCount > 0
            ? `<span class="badge badge-accent">${diag.turnCount} turn(s) · ${formatCost(diag.totalCostUSD)}</span>`
            : "";

          let imgTag = "";
          if (format === "png" && diag.pngDataUri) {
            imgTag = `<img src="${diag.pngDataUri}" alt="${escapeHtml(diag.name)}" style="display: block;" />`;
          } else if (format === "raw-svg") {
            imgTag = diag.svg;
          } else {
            const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(diag.svg).toString("base64")}`;
            imgTag = `<img src="${svgDataUri}" alt="${escapeHtml(diag.name)}" style="display: block;" />`;
          }

          return `
            <div class="diagram-viewer" id="viewer-diagram-${idx}">
              <div class="diagram-toolbar">
                <div class="diagram-info">
                  <span>${title}</span>
                  ${badge}
                </div>
                <div class="diagram-actions">
                  <button type="button" class="btn-tool" data-action="zoom-in" title="Zoom In (+)">➕ Zoom In</button>
                  <button type="button" class="btn-tool" data-action="zoom-out" title="Zoom Out (-)">➖ Zoom Out</button>
                  <button type="button" class="btn-tool" data-action="reset" title="Reset View (100%)">⟲ 100%</button>
                  <button type="button" class="btn-tool" data-action="fit" title="Fit to Viewport">⛶ Fit</button>
                  <span class="zoom-pill" data-zoom-label>100%</span>
                </div>
              </div>
              <div class="diagram-viewport" data-viewport tabindex="0" title="Scroll to zoom, click and drag to pan">
                <div class="diagram-canvas" data-canvas>
                  ${imgTag}
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    }
  } catch (err) {
    console.error("[generateHtmlReport] Error during diagram rendering:", err);
    diagramCardsHtml = `<p class="text-muted">Diagram preview unavailable.</p>`;
  }

  let totalDurationMs = 0;
  for (const t of detail.turns) {
    if (t.startedAt && t.endedAt) totalDurationMs += t.endedAt - t.startedAt;
  }
  const durationStr = totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : "-";

  const promptHtml = detail.prompt
    ? `
      <div class="card">
        <h2>🎯 Task Prompt</h2>
        <blockquote class="prompt-box">${escapeHtml(detail.prompt)}</blockquote>
      </div>
    `
    : "";

  const errorBannerHtml = detail.harnessError
    ? `
      <div class="alert alert-danger">
        <strong>Harness Error:</strong> ${escapeHtml(detail.harnessError)}
      </div>
    `
    : "";

  const turnLogHtml = detail.turns.length === 0
    ? `<p class="text-muted">No turns executed.</p>`
    : detail.turns
        .map((t) => {
          const tools = t.toolCalls?.length
            ? `<div class="tool-tags">${t.toolCalls
                .map((name) => `<span class="tool-tag">${escapeHtml(name)}</span>`)
                .join("")}</div>`
            : "";
          const cost = t.usage?.cost?.total ? formatCost(t.usage.cost.total) : "$0.00";
          const cacheRead = t.usage?.cacheRead || 0;
          const cachedBadge = cacheRead > 0
            ? `<span class="badge badge-cache">cache ${formatTokens(cacheRead)}</span>`
            : `<span class="badge badge-muted">uncached</span>`;

          const summaryBlock = t.summary
            ? `<div class="turn-summary">${escapeHtml(t.summary)}</div>`
            : "";
          const errBlock = t.error
            ? `<div class="turn-error">⚠️ ${escapeHtml(t.error)}</div>`
            : "";

          return `
            <div class="turn-item" id="turn-${t.index}" data-activity="${escapeHtml(t.activityId)}">
              <div class="turn-header">
                <div>
                  <span class="badge badge-turn" style="margin-right: 0.35rem; font-size: 0.8rem;">T${t.index}</span>
                  <span class="turn-index">Turn ${t.index}</span>
                  <span class="turn-title">${escapeHtml(t.activityName || t.activityId)}</span>
                  <span class="turn-harness"><code>${escapeHtml(t.activityId)}</code> &middot; <code>${escapeHtml(t.harness || "-")}</code></span>
                </div>
                <div class="turn-meta">
                  ${cachedBadge}
                  <span class="badge badge-cost">${cost}</span>
                  ${t.stopReason ? `<span class="badge badge-stop">${escapeHtml(t.stopReason)}</span>` : ""}
                </div>
              </div>
              ${summaryBlock}
              ${tools}
              ${errBlock}
            </div>
          `;
        })
        .join("");

  const revisionsHtml = detail.revisions.length === 0
    ? ""
    : `
      <div class="card">
        <h2>Graph Revisions & Evolution</h2>
        <div class="revisions-list">
          ${detail.revisions.map((r) => `
            <div class="revision-item">
              <div class="revision-header">
                <span class="revision-index">r${r.index}</span>
                <span class="revision-time">${new Date(r.at).toLocaleTimeString()}</span>
              </div>
              <div class="revision-reason">${escapeHtml(r.reason)}</div>
              ${r.addedElementIds.length ? `<div class="revision-added">+ ${r.addedElementIds.map(escapeHtml).join(", ")}</div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session Report - ${escapeHtml(detail.name || detail.id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #f8fafc; color: #1e293b; line-height: 1.6; }
    .header-bar { margin-bottom: 2rem; }
    .header-title { font-size: 2rem; font-weight: 800; color: #0f172a; margin: 0 0 0.5rem 0; }
    .header-sub { font-size: 0.875rem; color: #64748b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .card h2 { font-size: 1.25rem; font-weight: 700; margin-top: 0; margin-bottom: 1rem; color: #0f172a; }
    .metrics { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .metric-box { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem 1.25rem; min-width: 130px; flex: 1; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
    .metric-val { font-size: 1.5rem; font-weight: 800; color: #0f766e; }
    .metric-lbl { font-size: 0.75rem; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 0.25rem; }
    .prompt-box { margin: 0; padding: 1rem 1.25rem; background: #f1f5f9; border-left: 4px solid #0f766e; border-radius: 4px; font-size: 0.95rem; color: #334155; white-space: pre-wrap; word-break: break-word; }
    
    /* Diagram Viewer with Pan & Zoom */
    .diagram-viewer { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 1.5rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
    .diagram-viewer:last-child { margin-bottom: 0; }
    .diagram-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; background: #f8fafc; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; gap: 0.5rem; }
    .diagram-info { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; font-size: 0.95rem; color: #1e293b; }
    .diagram-actions { display: flex; align-items: center; gap: 0.35rem; }
    .btn-tool { background: white; border: 1px solid #cbd5e1; border-radius: 4px; padding: 0.25rem 0.5rem; font-size: 0.8rem; font-weight: 600; color: #334155; cursor: pointer; transition: all 0.15s ease; user-select: none; }
    .btn-tool:hover { background: #f1f5f9; border-color: #94a3b8; color: #0f172a; }
    .zoom-pill { font-size: 0.75rem; font-family: ui-monospace, monospace; color: #64748b; min-width: 42px; text-align: center; font-weight: 600; }
    .diagram-viewport { position: relative; width: 100%; height: 460px; overflow: hidden; background: #ffffff; cursor: grab; user-select: none; }
    .diagram-viewport:active { cursor: grabbing; }
    .diagram-canvas { position: absolute; transform-origin: 0 0; display: inline-block; }
    .diagram-canvas img, .diagram-canvas svg { display: block; max-width: none; user-select: none; -webkit-user-drag: none; }

    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.875rem; }
    th, td { text-align: left; padding: 0.65rem 0.75rem; border-bottom: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; color: #475569; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f1f5f9; padding: 0.15em 0.35em; border-radius: 4px; }
    .badge { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 0.2em 0.5em; border-radius: 4px; font-family: ui-monospace, monospace; }
    .badge-accent { background: #0f766e; color: white; }
    .badge-turn { background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; }
    .badge-cache { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .badge-cost { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .badge-stop { background: #f1f5f9; color: #475569; }
    .badge-muted { background: #f1f5f9; color: #64748b; }
    .turn-item { border-bottom: 1px solid #e2e8f0; padding: 1rem 0; }
    .turn-item:last-child { border-bottom: none; }
    .turn-header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.5rem; }
    .turn-index { font-weight: 700; color: #0f172a; margin-right: 0.5rem; }
    .turn-title { font-weight: 600; color: #1e293b; margin-right: 0.5rem; }
    .turn-harness { font-size: 0.8rem; color: #64748b; }
    .turn-meta { display: flex; gap: 0.4rem; align-items: center; }
    .turn-summary { background: #f8fafc; border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.875rem; color: #334155; margin-top: 0.5rem; white-space: pre-wrap; }
    .turn-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px; padding: 0.75rem 1rem; font-size: 0.875rem; margin-top: 0.5rem; }
    .tool-tags { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.5rem; }
    .tool-tag { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-family: monospace; font-size: 0.75rem; padding: 0.15rem 0.45rem; border-radius: 4px; }
    .revisions-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .revision-item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; }
    .revision-header { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.25rem; font-size: 0.875rem; }
    .revision-time { font-size: 0.75rem; color: #64748b; font-weight: normal; }
    .revision-reason { font-size: 0.875rem; color: #334155; }
    .revision-added { font-family: monospace; font-size: 0.75rem; color: #0f766e; margin-top: 0.25rem; }
    .alert { padding: 1rem 1.25rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .alert-danger { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  </style>
</head>
<body>
  <div class="header-bar">
    <h1 class="header-title">${escapeHtml(detail.name || detail.id)}</h1>
    <div class="header-sub">
      Session: <code>${escapeHtml(detail.id)}</code> &middot;
      Project: <code>${escapeHtml(detail.project)}</code>
      ${detail.model ? ` &middot; Model: <code>${escapeHtml(detail.model)}</code>` : ""}
    </div>
  </div>

  ${errorBannerHtml}

  <div class="metrics">
    <div class="metric-box"><div class="metric-val">${detail.status}</div><div class="metric-lbl">Status</div></div>
    <div class="metric-box"><div class="metric-val">${formatCost(detail.stats?.totalCostUSD || 0)}</div><div class="metric-lbl">Total Cost</div></div>
    <div class="metric-box"><div class="metric-val">${detail.turnCount}</div><div class="metric-lbl">Turns</div></div>
    <div class="metric-box"><div class="metric-val">${formatTokens(detail.stats?.totalTokens || 0)}</div><div class="metric-lbl">Tokens</div></div>
    <div class="metric-box"><div class="metric-val">${Math.round((detail.stats?.cacheHitRatio || 0) * 100)}%</div><div class="metric-lbl">Cache Hit</div></div>
    <div class="metric-box"><div class="metric-val">${durationStr}</div><div class="metric-lbl">Duration</div></div>
  </div>

  ${promptHtml}

  <div class="card">
    <h2>📊 Execution Diagrams</h2>
    ${diagramCardsHtml}
  </div>

  <div class="card">
    <h2>📈 Activity Breakdown</h2>
    <table>
      <thead>
        <tr><th>Activity</th><th>Symbol</th><th>Harness</th><th>Turns</th><th>Tokens (In / Out / Cache)</th><th>Reasoning</th><th>Cost ($ USD)</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${computeActivitySummaries(detail.turns).map(a => `
          <tr>
            <td><code>${escapeHtml(a.activityId)}</code></td>
            <td><span class="badge badge-turn">${formatTurnRange(a.turnIndices) || "-"}</span></td>
            <td><code>${escapeHtml(a.harness)}</code></td>
            <td>${a.turns}</td>
            <td>${formatTokens(a.inputTokens)} / ${formatTokens(a.outputTokens)} / ${formatTokens(a.cacheReadTokens)}</td>
            <td>${formatTokens(a.reasoningTokens)}</td>
            <td><strong>${formatCost(a.costUSD)}</strong></td>
            <td>${a.durationMs > 0 ? (a.durationMs / 1000).toFixed(1) + "s" : "-"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>📜 Chronological Turn Log & Transcript</h2>
    ${turnLogHtml}
  </div>

  ${revisionsHtml}

  <script>
    document.querySelectorAll('.diagram-viewer').forEach((viewer) => {
      const viewport = viewer.querySelector('[data-viewport]');
      const canvas = viewer.querySelector('[data-canvas]');
      const zoomLabel = viewer.querySelector('[data-zoom-label]');
      if (!viewport || !canvas) return;

      let scale = 1;
      let translateX = 0;
      let translateY = 0;
      let isPanning = false;
      let startX = 0;
      let startY = 0;

      function updateTransform() {
        canvas.style.transform = "translate(" + translateX + "px, " + translateY + "px) scale(" + scale + ")";
        if (zoomLabel) zoomLabel.textContent = Math.round(scale * 100) + "%";
      }

      function fitDiagram() {
        const vRect = viewport.getBoundingClientRect();
        const img = canvas.querySelector('img, svg');
        if (!img) return;
        const iWidth = img.naturalWidth || img.clientWidth || 800;
        const iHeight = img.naturalHeight || img.clientHeight || 400;
        if (iWidth === 0 || iHeight === 0) return;
        const scaleX = (vRect.width - 32) / iWidth;
        const scaleY = (vRect.height - 32) / iHeight;
        scale = Math.min(scaleX, scaleY, 1.2);
        translateX = Math.max(16, (vRect.width - iWidth * scale) / 2);
        translateY = Math.max(16, (vRect.height - iHeight * scale) / 2);
        updateTransform();
      }

      // Initial fit after image load
      const img = canvas.querySelector('img');
      if (img) {
        if (img.complete) {
          fitDiagram();
        } else {
          img.addEventListener('load', fitDiagram);
        }
      } else {
        fitDiagram();
      }

      // Mouse wheel zoom
      viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const delta = e.deltaY < 0 ? 1.15 : 0.87;
        const newScale = Math.min(Math.max(scale * delta, 0.15), 6.0);
        translateX = mouseX - (mouseX - translateX) * (newScale / scale);
        translateY = mouseY - (mouseY - translateY) * (newScale / scale);
        scale = newScale;
        updateTransform();
      }, { passive: false });

      // Pan by dragging
      viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isPanning = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
        viewport.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
      });

      window.addEventListener('mouseup', () => {
        if (isPanning) {
          isPanning = false;
          viewport.style.cursor = 'grab';
        }
      });

      // Double-click to toggle fit / 100%
      viewport.addEventListener('dblclick', () => {
        if (Math.abs(scale - 1) < 0.1) {
          fitDiagram();
        } else {
          scale = 1;
          translateX = 20;
          translateY = 20;
          updateTransform();
        }
      });

      // Controls
      viewer.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => {
        scale = Math.min(scale * 1.25, 6.0);
        updateTransform();
      });
      viewer.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => {
        scale = Math.max(scale / 1.25, 0.15);
        updateTransform();
      });
      viewer.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
        scale = 1;
        translateX = 20;
        translateY = 20;
        updateTransform();
      });
      viewer.querySelector('[data-action="fit"]')?.addEventListener('click', fitDiagram);
    });
  </script>
</body>
</html>`;
}

export async function cmdReport(
  id: string | undefined,
  flags: {
    format?: string;
    out?: string;
    embedSvg?: boolean;
    embedDataUri?: boolean;
    imageFormat?: "png" | "svg" | "raw-svg";
    scale?: number;
  }
): Promise<number> {
  const p = requirePaths();
  if (!p) return 1;
  if (!id) {
    process.stderr.write("graph-agent: report requires a session id\n");
    return 2;
  }
  const store = new SessionStore(p, id);
  if (!store.exists()) {
    process.stderr.write(`graph-agent: unknown session '${id}'\n`);
    return 1;
  }
  const detail = store.detail();
  const format = flags.format || "markdown";

  let output = "";
  if (format === "json") {
    output = JSON.stringify(detail, null, 2);
  } else if (format === "html") {
    output = await generateHtmlReport(detail, {
      imageFormat: flags.imageFormat || "png",
      scale: flags.scale,
    });
  } else {
    output = await generateMarkdownReport(detail, {
      embedSvg: flags.embedSvg,
      embedDataUri: flags.embedDataUri,
      imageFormat: flags.imageFormat === "svg" ? "svg" : "png",
      scale: flags.scale,
    });
  }

  if (flags.out) {
    const targetPath = resolve(flags.out);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, output);
    process.stdout.write(`wrote report to ${flags.out}\n`);
  } else {
    process.stdout.write(output);
  }
  return 0;
}

export async function cmdExport(
  target: string | undefined,
  flags: {
    out?: string;
    format?: "png" | "svg";
    dataUri?: boolean;
    scale?: number;
    background?: string;
  }
): Promise<number> {
  if (!target) {
    process.stderr.write("graph-agent: export requires a session id or .bpmn file path\n");
    return 2;
  }

  // Infer format from flags.format or file extension in flags.out
  const format = flags.format || (flags.out?.endsWith(".png") ? "png" : "svg");
  const p = requirePaths();
  const isSession = p && new SessionStore(p, target).exists();

  let dataBuffer: Buffer | string = "";
  if (format === "png") {
    if (flags.dataUri) {
      dataBuffer = isSession
        ? await renderSessionPngDataUri(new SessionStore(p!, target).detail(), {
            scale: flags.scale ?? 2,
            showCostBadges: true,
            background: flags.background ?? "#ffffff",
          })
        : await renderToPngDataUri(
            await (async () => {
              const { readFileSync } = await import("node:fs");
              return readFileSync(target, "utf-8");
            })(),
            { scale: flags.scale ?? 2, background: flags.background ?? "#ffffff" }
          );
    } else {
      dataBuffer = isSession
        ? await renderSessionPng(new SessionStore(p!, target).detail(), {
            scale: flags.scale ?? 2,
            showCostBadges: true,
            background: flags.background ?? "#ffffff",
          })
        : await renderToPng(
            await (async () => {
              const { readFileSync } = await import("node:fs");
              return readFileSync(target, "utf-8");
            })(),
            { scale: flags.scale ?? 2, background: flags.background ?? "#ffffff" }
          );
    }
  } else {
    if (flags.dataUri) {
      dataBuffer = isSession
        ? await renderSessionSvgDataUri(new SessionStore(p!, target).detail(), {
            showCostBadges: true,
            background: flags.background,
          })
        : await renderToSvgDataUri(
            await (async () => {
              const { readFileSync } = await import("node:fs");
              return readFileSync(target, "utf-8");
            })(),
            { background: flags.background }
          );
    } else {
      dataBuffer = isSession
        ? await renderSessionSvg(new SessionStore(p!, target).detail(), {
            showCostBadges: true,
            background: flags.background,
          })
        : await renderToSvg(
            await (async () => {
              const { readFileSync } = await import("node:fs");
              return readFileSync(target, "utf-8");
            })(),
            { background: flags.background }
          );
    }
  }

  if (flags.out) {
    const targetPath = resolve(flags.out);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, dataBuffer);
    process.stdout.write(`exported diagram to ${flags.out}\n`);
  } else {
    process.stdout.write(typeof dataBuffer === "string" ? dataBuffer : dataBuffer.toString("utf-8"));
  }
  return 0;
}
