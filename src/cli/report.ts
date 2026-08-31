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

export function renderMarkdownToHtml(md: string): string {
  if (!md) return "";
  const codeBlocks: string[] = [];
  let text = md.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<div class="terminal-card" style="margin: 0.5rem 0;">` +
      (lang ? `<div class="terminal-bar"><span class="terminal-title">${escapeHtml(lang)}</span></div>` : "") +
      `<pre class="code-block" style="margin: 0;"><code>${escapeHtml(code.trim())}</code></pre></div>`
    );
    return `___CODE_BLOCK_${idx}___`;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`);
  text = text.replace(/\*([^*]+)\*/g, (_m, it) => `<em>${it}</em>`);

  const paragraphs = text.split(/\n\n+/).map(p => {
    p = p.replace(/\n/g, "<br>");
    return `<div class="md-para">${p}</div>`;
  }).join("");

  return paragraphs.replace(/___CODE_BLOCK_(\d+)___/g, (_m, idx) => codeBlocks[Number(idx)] || "");
}

function formatToolCallMarkdown(tc: { id: string; name: string; arguments?: Record<string, unknown>; result?: { content: string; isError?: boolean } }): string {
  const status = tc.result ? (tc.result.isError ? "failed" : "ok") : "pending";
  let md = `<details>\n<summary>Tool: <code>${tc.name}</code> (${tc.id}) — ${status}</summary>\n\n`;

  if (tc.name === "bash" && tc.arguments?.command) {
    md += `**Command**:\n\`\`\`bash\n$ ${String(tc.arguments.command)}\n\`\`\`\n\n`;
    if (tc.result) {
      md += `**Output**${tc.result.isError ? " (Failed)" : ""}:\n\`\`\`text\n${tc.result.content || "(no output)"}\n\`\`\`\n\n`;
    }
  } else if (tc.name === "edit" && tc.arguments?.path) {
    md += `**File**: \`${tc.arguments.path}\`\n\n`;
    const edits = Array.isArray(tc.arguments.edits) ? tc.arguments.edits : [];
    if (edits.length > 0) {
      md += `**Edits**:\n\`\`\`diff\n`;
      for (const e of edits) {
        if (e.oldText) {
          md += e.oldText.split("\n").map((l: string) => `- ${l}`).join("\n") + "\n";
        }
        if (e.newText) {
          md += e.newText.split("\n").map((l: string) => `+ ${l}`).join("\n") + "\n";
        }
      }
      md += `\`\`\`\n\n`;
    }
    if (tc.result) {
      md += `**Result**: ${tc.result.content}\n\n`;
    }
  } else {
    if (tc.arguments && Object.keys(tc.arguments).length > 0) {
      md += `**Arguments**:\n\`\`\`json\n${JSON.stringify(tc.arguments, null, 2)}\n\`\`\`\n\n`;
    }
    if (tc.result) {
      md += `**Result**${tc.result.isError ? " (Error)" : ""}:\n\`\`\`text\n${tc.result.content || "(empty)"}\n\`\`\`\n\n`;
    }
  }
  md += `</details>\n\n`;
  return md;
}

function formatToolCallHtml(tc: { id: string; name: string; arguments?: Record<string, unknown>; durationMs?: number; result?: { content: string; isError?: boolean } }, isVerbose: boolean): string {
  const statusBadge = tc.result
    ? (tc.result.isError ? `<span class="badge badge-error">failed</span>` : `<span class="badge badge-success">ok</span>`)
    : `<span class="badge badge-pending">pending</span>`;
  const durStr = tc.durationMs ? `<span class="tool-dur">${(tc.durationMs / 1000).toFixed(2)}s</span>` : "";

  let bodyHtml = "";
  if (tc.name === "bash" && tc.arguments?.command) {
    const cmd = String(tc.arguments.command);
    bodyHtml = `
      <div class="terminal-card">
        <div class="terminal-bar">
          <span class="terminal-title">Terminal</span>
          <button type="button" class="btn-copy" data-copy="${escapeHtml(cmd)}" title="Copy Command">Copy</button>
        </div>
        <pre class="terminal-cmd"><code>$ ${escapeHtml(cmd)}</code></pre>
      </div>
      <div class="tool-result-section">
        <div class="detail-subheading">Output ${tc.result ? (tc.result.isError ? "(Error)" : "(Success)") : ""}:</div>
        <pre class="code-block ${tc.result?.isError ? 'code-error' : ''}">${escapeHtml(tc.result?.content || '(no output)')}</pre>
      </div>
    `;
  } else if (tc.name === "edit" && tc.arguments?.path) {
    const path = String(tc.arguments.path);
    const edits = Array.isArray(tc.arguments.edits) ? tc.arguments.edits : [];
    let diffHtml = "";
    if (edits.length > 0) {
      diffHtml = edits.map((e, idx) => `
        <div class="diff-container">
          <div class="diff-title">Replacement #${idx + 1}</div>
          ${e.oldText ? `<div class="diff-chunk diff-old"><pre>${escapeHtml(e.oldText)}</pre></div>` : ""}
          ${e.newText ? `<div class="diff-chunk diff-new"><pre>${escapeHtml(e.newText)}</pre></div>` : ""}
        </div>
      `).join("");
    }
    bodyHtml = `
      <div class="file-path-badge">File: <code>${escapeHtml(path)}</code></div>
      ${diffHtml}
      <div class="tool-result-section">
        <div class="detail-subheading">Result:</div>
        <pre class="code-block">${escapeHtml(tc.result?.content || 'ok')}</pre>
      </div>
    `;
  } else if ((tc.name === "read" || tc.name === "write") && tc.arguments?.path) {
    const path = String(tc.arguments.path);
    const writeContent = tc.name === "write" && typeof tc.arguments.content === "string" ? tc.arguments.content : "";
    bodyHtml = `
      <div class="file-path-badge">File: <code>${escapeHtml(path)}</code> <span class="badge badge-muted">${escapeHtml(tc.name)}</span></div>
      ${writeContent ? `<div class="detail-subheading">Written Content:</div><pre class="code-block">${escapeHtml(writeContent)}</pre>` : ""}
      <div class="tool-result-section">
        <div class="detail-subheading">Result:</div>
        <pre class="code-block ${tc.result?.isError ? 'code-error' : ''}">${escapeHtml(tc.result?.content || '(empty)')}</pre>
      </div>
    `;
  } else {
    const argsHtml = tc.arguments && Object.keys(tc.arguments).length > 0
      ? `<div class="detail-subheading">Arguments:</div><pre class="code-block">${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</pre>`
      : "";
    const resultHtml = tc.result
      ? `<div class="detail-subheading">Result ${tc.result.isError ? "(Error)" : ""}:</div><pre class="code-block ${tc.result.isError ? 'code-error' : ''}">${escapeHtml(tc.result.content || "(empty)")}</pre>`
      : "";
    bodyHtml = `${argsHtml}${resultHtml}`;
  }

  return `
    <details class="detail-box tool-card" ${isVerbose ? "open" : ""}>
      <summary class="detail-summary">
        <div>
          <span class="tool-name-badge">${escapeHtml(tc.name)}</span>
          <span class="tool-id-label">${escapeHtml(tc.id)}</span>
          ${durStr}
        </div>
        ${statusBadge}
      </summary>
      <div class="detail-body">
        ${bodyHtml}
      </div>
    </details>
  `;
}

export async function generateMarkdownReport(
  detail: SessionDetail,
  options: {
    embedSvg?: boolean;
    embedDataUri?: boolean;
    imageFormat?: "png" | "svg";
    scale?: number;
    verbose?: boolean;
  } = {}
): Promise<string> {
  const stats = detail.stats;
  const itemsToReport = detail.steps && detail.steps.length > 0 ? detail.steps : detail.turns;
  const activities = computeActivitySummaries(itemsToReport);
  const totalCost = stats?.totalCostUSD ? formatCost(stats.totalCostUSD) : "$0.00";
  const totalTokens = stats?.totalTokens ? formatTokens(stats.totalTokens) : "0";
  const cacheHit = stats?.cacheHitRatio !== undefined ? `${Math.round(stats.cacheHitRatio * 100)}%` : "0%";

  let totalDurationMs = 0;
  for (const t of itemsToReport) {
    if (t.startedAt && t.endedAt) totalDurationMs += t.endedAt - t.startedAt;
  }
  const durationStr = totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : "-";

  let totalToolCalls = 0;
  for (const t of itemsToReport) {
    totalToolCalls += t.toolCallDetails?.length || t.toolCalls?.length || 0;
  }

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
  if (itemsToReport.length === 0) {
    turnLog += "_No turns executed._\n";
  } else {
    for (const turn of itemsToReport) {
      const toolList = turn.toolCalls?.length ? turn.toolCalls.map((t) => `\`${t}\``).join(", ") : "-";
      const tokens = turn.usage
        ? `in: ${turn.usage.input}, out: ${turn.usage.output}, cacheRead: ${turn.usage.cacheRead}`
        : "-";
      const cost = turn.usage?.cost?.total ? formatCost(turn.usage.cost.total) : "$0.00";
      const stopReason = turn.stopReason ? ` (${turn.stopReason})` : "";
      const turnDur = turn.startedAt && turn.endedAt ? ` · ${(turn.endedAt - turn.startedAt) / 1000}s` : "";

      turnLog += `### [T${turn.index}] Turn ${turn.index}: ${turn.activityName || turn.activityId}${stopReason}\n\n`;
      turnLog += `- **Activity**: \`${turn.activityId}\` (\`${turn.harness || "-"}\`)\n`;
      turnLog += `- **Tokens & Cost**: ${tokens} · **${cost}**${turnDur}\n`;
      turnLog += `- **Tools Called**: ${toolList}\n`;
      if (turn.summary) {
        turnLog += `\n**Response Summary**:\n> ${turn.summary.replace(/\n/g, "\n> ")}\n\n`;
      }
      if (turn.error) {
        turnLog += `\n> **Error**: ${turn.error}\n\n`;
      }
      if (options.verbose) {
        if (turn.prompt) {
          turnLog += `<details>\n<summary>Input Prompt (${turn.prompt.length} chars)</summary>\n\n\`\`\`text\n${turn.prompt}\n\`\`\`\n</details>\n\n`;
        } else if (turn.inputs && Object.keys(turn.inputs).length > 0) {
          turnLog += `<details>\n<summary>Inputs</summary>\n\n\`\`\`json\n${JSON.stringify(turn.inputs, null, 2)}\n\`\`\`\n</details>\n\n`;
        }

        if (turn.thinking) {
          turnLog += `<details>\n<summary>Thinking / Reasoning (${turn.thinking.length} chars)</summary>\n\n\`\`\`text\n${turn.thinking}\n\`\`\`\n</details>\n\n`;
        }

        if (turn.response && turn.response !== turn.summary) {
          turnLog += `<details>\n<summary>Model Response (${turn.response.length} chars)</summary>\n\n\`\`\`text\n${turn.response}\n\`\`\`\n</details>\n\n`;
        } else if (turn.outputs && Object.keys(turn.outputs).length > 0 && !turn.response) {
          turnLog += `<details>\n<summary>Outputs</summary>\n\n\`\`\`json\n${JSON.stringify(turn.outputs, null, 2)}\n\`\`\`\n</details>\n\n`;
        }
      }

      if (turn.toolCallDetails && turn.toolCallDetails.length > 0) {
        turnLog += `**Tool Call Details**:\n\n`;
        for (const tc of turn.toolCallDetails) {
          turnLog += formatToolCallMarkdown(tc);
        }
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
    errorSection = `\n> **Harness Error**: ${detail.harnessError}\n`;
  }

  return `# Session Report: ${detail.name || detail.id}

- **Session ID**: \`${detail.id}\`
- **Status**: \`${detail.status}\`
- **Model**: \`${detail.model || "default"}\`
- **Total Cost**: **${totalCost}**
- **Turns**: ${detail.turnCount}
- **Tool Calls**: ${totalToolCalls}
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
  options: {
    imageFormat?: "png" | "svg" | "raw-svg";
    scale?: number;
    verbose?: boolean;
  } = {}
): Promise<string> {
  const format = options.imageFormat || "png";
  let diagramSectionHtml = "";

  try {
    const rendered = await renderSessionDiagrams(detail, {
      showCostBadges: true,
      background: "#ffffff",
      includePngDataUri: format === "png",
      scale: options.scale ?? 2,
    });

    if (rendered.length === 0) {
      diagramSectionHtml = `<p class="text-muted">Diagram preview unavailable.</p>`;
    } else {
      const tabsNavHtml = rendered.length > 1
        ? `
          <div class="diagram-tabs-nav">
            ${rendered.map((diag, idx) => {
              const tabTitle = diag.isRoot ? `Root: ${escapeHtml(diag.name)}` : `Subprocess: ${escapeHtml(diag.name)}`;
              const turnRange = diag.turnCount > 0 ? `<span class="badge badge-accent">${diag.turnCount} turn(s)</span>` : "";
              return `
                <button type="button" class="diagram-tab-btn ${idx === 0 ? 'active' : ''}" data-tab-target="pane-diag-${idx}">
                  <span>${tabTitle}</span>
                  ${turnRange}
                </button>
              `;
            }).join("")}
          </div>
        `
        : "";

      const panesHtml = rendered.map((diag, idx) => {
        const title = diag.isRoot ? `${escapeHtml(diag.name)} (Root Process)` : `Subprocess: ${escapeHtml(diag.name)}`;
        const badge = diag.turnCount > 0
          ? `<span class="badge badge-accent">${diag.turnCount} turn(s) · ${formatCost(diag.totalCostUSD)}</span>`
          : "";

        let imgTag = "";
        if (format === "png" && diag.pngDataUri) {
          imgTag = `<img src="${diag.pngDataUri}" alt="${escapeHtml(diag.name)}" draggable="false" style="display: block; user-select: none; -webkit-user-drag: none; pointer-events: none;" />`;
        } else if (format === "raw-svg") {
          imgTag = diag.svg;
        } else {
          const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(diag.svg).toString("base64")}`;
          imgTag = `<img src="${svgDataUri}" alt="${escapeHtml(diag.name)}" draggable="false" style="display: block; user-select: none; -webkit-user-drag: none; pointer-events: none;" />`;
        }

        return `
          <div class="diagram-tab-pane ${idx === 0 ? 'active' : ''}" id="pane-diag-${idx}" style="${idx === 0 ? '' : 'display: none;'}">
            <div class="diagram-viewer" id="viewer-diagram-${idx}">
              <div class="diagram-viewport" data-viewport tabindex="0" title="Scroll to zoom, click and drag to pan">
                <div class="diagram-floating-info">
                  <span>${title}</span>
                  ${badge}
                </div>
                <div class="diagram-floating-controls">
                  <button type="button" class="btn-tool" data-action="zoom-in" title="Zoom In (+)">Zoom In</button>
                  <button type="button" class="btn-tool" data-action="zoom-out" title="Zoom Out (-)">Zoom Out</button>
                  <button type="button" class="btn-tool" data-action="reset" title="Reset View (100%)">100%</button>
                  <button type="button" class="btn-tool" data-action="fit" title="Fit to Viewport">Fit</button>
                  <span class="zoom-pill" data-zoom-label>100%</span>
                </div>
                <div class="diagram-canvas" data-canvas>
                  ${imgTag}
                </div>
                <div class="diagram-floating-legend">
                  <span class="legend-item"><span class="legend-dot dot-1x"></span> 1× Pass</span>
                  <span class="legend-item"><span class="legend-dot dot-mid"></span> 2–4× Loop</span>
                  <span class="legend-item"><span class="legend-dot dot-high"></span> 5+× Hot Path</span>
                  <span class="legend-item"><span class="legend-dot dot-error"></span> Failed / Error</span>
                  <span class="legend-item"><span class="legend-dot dot-unvisited"></span> Unvisited</span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");

      diagramSectionHtml = `
        <div class="diagram-tabs-container">
          ${tabsNavHtml}
          ${panesHtml}
        </div>
      `;
    }
  } catch (err) {
    console.error("[generateHtmlReport] Error during diagram rendering:", err);
    diagramSectionHtml = `<p class="text-muted">Diagram preview unavailable.</p>`;
  }

  const itemsToReport = detail.steps && detail.steps.length > 0 ? detail.steps : detail.turns;
  let totalDurationMs = 0;
  let totalToolCallsCount = 0;
  let errorCount = 0;

  for (const t of itemsToReport) {
    if (t.startedAt && t.endedAt) totalDurationMs += t.endedAt - t.startedAt;
    totalToolCallsCount += t.toolCallDetails?.length || t.toolCalls?.length || 0;
    if (t.error || t.stopReason === "error" || t.toolCallDetails?.some(tc => tc.result?.isError)) {
      errorCount++;
    }
  }
  const durationStr = totalDurationMs > 0 ? `${(totalDurationMs / 1000).toFixed(1)}s` : "-";

  const promptHtml = detail.prompt
    ? `
      <div class="card">
        <h2>Task Prompt</h2>
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

  const isVerbose = options.verbose === true;

  const turnLogHtml = itemsToReport.length === 0
    ? `<p class="text-muted">No turns executed.</p>`
    : itemsToReport
        .map((t) => {
          const hasToolCalls = (t.toolCallDetails?.length || 0) > 0 || (t.toolCalls?.length || 0) > 0;
          const hasError = Boolean(t.error || t.stopReason === "error" || t.toolCallDetails?.some(tc => tc.result?.isError));

          const tools = t.toolCallDetails?.length
            ? `<div class="tool-details-container">
                <div class="section-subtitle">Tool Invocations (${t.toolCallDetails.length})</div>
                ${t.toolCallDetails.map(tc => formatToolCallHtml(tc, isVerbose)).join("")}
              </div>`
            : t.toolCalls?.length
            ? `<div class="tool-tags">${t.toolCalls
                .map((name) => `<span class="tool-tag">${escapeHtml(name)}</span>`)
                .join("")}</div>`
            : "";

          const promptBlock = t.prompt
            ? `
              <details class="detail-box" ${isVerbose ? "open" : ""}>
                <summary class="detail-summary">
                  <span><strong>Input Prompt</strong> (${t.prompt.length} chars)</span>
                  <button type="button" class="btn-copy" data-copy="${escapeHtml(t.prompt)}" title="Copy Prompt">Copy</button>
                </summary>
                <div class="detail-body">
                  <pre class="code-block">${escapeHtml(t.prompt)}</pre>
                </div>
              </details>
            `
            : t.inputs && Object.keys(t.inputs).length > 0 && t.inputs.prompt !== null
            ? `
              <details class="detail-box" ${isVerbose ? "open" : ""}>
                <summary class="detail-summary">
                  <span><strong>Inputs</strong> (${Object.keys(t.inputs).length} field(s))</span>
                </summary>
                <div class="detail-body">
                  <pre class="code-block">${escapeHtml(JSON.stringify(t.inputs, null, 2))}</pre>
                </div>
              </details>
            `
            : "";

          const thinkingBlock = t.thinking
            ? `
              <details class="detail-box thinking-box" ${isVerbose ? "open" : ""}>
                <summary class="detail-summary">
                  <span><strong>Thinking / Reasoning</strong> (${t.thinking.length} chars)</span>
                  <button type="button" class="btn-copy" data-copy="${escapeHtml(t.thinking)}" title="Copy Thinking">Copy</button>
                </summary>
                <div class="detail-body">
                  <pre class="code-block" style="color: #cbd5e1; font-style: italic;">${escapeHtml(t.thinking)}</pre>
                </div>
              </details>
            `
            : "";

          const responseBlock = t.response && t.response !== t.summary
            ? `
              <details class="detail-box" ${isVerbose ? "open" : ""}>
                <summary class="detail-summary">
                  <span><strong>Model Response</strong> (${t.response.length} chars)</span>
                  <button type="button" class="btn-copy" data-copy="${escapeHtml(t.response)}" title="Copy Response">Copy</button>
                </summary>
                <div class="detail-body">
                  <pre class="code-block">${escapeHtml(t.response)}</pre>
                </div>
              </details>
            `
            : t.outputs && Object.keys(t.outputs).length > 0 && !t.response
            ? `
              <details class="detail-box" ${isVerbose ? "open" : ""}>
                <summary class="detail-summary">
                  <span><strong>Outputs</strong></span>
                </summary>
                <div class="detail-body">
                  <pre class="code-block">${escapeHtml(JSON.stringify(t.outputs, null, 2))}</pre>
                </div>
              </details>
            `
            : "";

          const cost = t.usage?.cost?.total ? formatCost(t.usage.cost.total) : "$0.00";
          const cacheRead = t.usage?.cacheRead || 0;
          const cachedBadge = cacheRead > 0
            ? `<span class="badge badge-cache">cache ${formatTokens(cacheRead)}</span>`
            : `<span class="badge badge-muted">uncached</span>`;

          const turnDur = t.startedAt && t.endedAt ? `<span class="badge badge-dur">${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s</span>` : "";

          const summaryBlock = t.summary
            ? `<div class="turn-summary">${renderMarkdownToHtml(t.summary)}</div>`
            : "";
          const errBlock = t.error
            ? `<div class="turn-error">${escapeHtml(t.error)}</div>`
            : "";

          return `
            <div class="turn-item ${hasToolCalls ? 'has-tools' : ''} ${hasError ? 'has-error' : ''}" id="turn-${t.index}" data-activity="${escapeHtml(t.activityId)}">
              <div class="turn-header">
                <div>
                  <span class="badge badge-turn" style="margin-right: 0.35rem; font-size: 0.75rem;">T${t.index}</span>
                  <span class="turn-index">Turn ${t.index}</span>
                  <span class="turn-title">${escapeHtml(t.activityName || t.activityId)}</span>
                  <span class="turn-harness"><code>${escapeHtml(t.activityId)}</code> &middot; <code>${escapeHtml(t.harness || "-")}</code></span>
                </div>
                <div class="turn-meta">
                  ${cachedBadge}
                  ${turnDur}
                  <span class="badge badge-cost">${cost}</span>
                  ${t.stopReason ? `<span class="badge badge-stop">${escapeHtml(t.stopReason)}</span>` : ""}
                </div>
              </div>
              ${summaryBlock}
              ${promptBlock}
              ${thinkingBlock}
              ${responseBlock}
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
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 1.5rem; background: #f8fafc; color: #0f172a; font-size: 13px; line-height: 1.5; }
    .header-bar { margin-bottom: 1.25rem; }
    .header-title { font-size: 1.5rem; font-weight: 700; color: #0f172a; margin: 0 0 0.25rem 0; letter-spacing: -0.01em; }
    .header-sub { font-size: 12px; color: #64748b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 4px; padding: 1rem 1.25rem; margin-bottom: 1rem; box-shadow: none; }
    .card h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0; margin-bottom: 0.75rem; color: #475569; }
    .metrics { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .metric-box { background: white; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0.5rem 0.75rem; min-width: 100px; flex: 1; box-shadow: none; }
    .metric-val { font-size: 1.15rem; font-weight: 700; color: #0f766e; line-height: 1.2; }
    .metric-lbl { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-top: 0.2rem; letter-spacing: 0.05em; }
    .prompt-box { margin: 0; padding: 0.75rem 1rem; background: #f8fafc; border-left: 3px solid #0f766e; border-radius: 2px; font-size: 13px; color: #334155; white-space: pre-wrap; word-break: break-word; }

    /* Tabbed Diagram View */
    .diagram-tabs-container { border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden; background: white; }
    .diagram-tabs-nav { display: flex; background: #f8fafc; border-bottom: 1px solid #e2e8f0; gap: 0.25rem; padding: 0 0.5rem; overflow-x: auto; }
    .diagram-tab-btn { background: transparent; border: none; border-bottom: 2px solid transparent; padding: 0.45rem 0.75rem; font-size: 12px; font-weight: 500; color: #64748b; cursor: pointer; display: flex; align-items: center; gap: 0.4rem; border-radius: 0; transition: all 0.15s; white-space: nowrap; }
    .diagram-tab-btn:hover { color: #0f172a; }
    .diagram-tab-btn.active { color: #0f766e; border-bottom-color: #0f766e; font-weight: 600; background: transparent; }
    .diagram-tab-pane { width: 100%; }

    /* Diagram Viewer with Pan & Zoom (Floating Camunda-style Controls) */
    .diagram-viewer { background: #ffffff; overflow: hidden; position: relative; }
    .btn-tool { background: white; border: 1px solid #cbd5e1; border-radius: 3px; padding: 0.2rem 0.45rem; font-size: 11px; font-weight: 600; color: #475569; cursor: pointer; transition: all 0.15s ease; user-select: none; }
    .btn-tool:hover { background: #f1f5f9; border-color: #94a3b8; color: #0f172a; }
    .zoom-pill { font-size: 11px; font-family: ui-monospace, monospace; color: #64748b; min-width: 36px; text-align: center; font-weight: 600; }
    .diagram-viewport { position: relative; width: 100%; height: 460px; overflow: hidden; background: #ffffff; cursor: grab; user-select: none; touch-action: none; }
    .diagram-viewport:active { cursor: grabbing; }
    .diagram-floating-info { position: absolute; top: 10px; left: 10px; z-index: 10; display: flex; align-items: center; gap: 6px; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(4px); border: 1px solid #e2e8f0; border-radius: 3px; padding: 3px 8px; font-size: 11.5px; font-weight: 600; color: #1e293b; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); pointer-events: none; }
    .diagram-floating-controls { position: absolute; top: 10px; right: 10px; z-index: 10; display: flex; align-items: center; gap: 3px; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(4px); border: 1px solid #e2e8f0; border-radius: 3px; padding: 3px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); }
    .diagram-floating-legend { position: absolute; bottom: 10px; left: 10px; z-index: 10; display: flex; align-items: center; gap: 10px; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(4px); border: 1px solid #e2e8f0; border-radius: 3px; padding: 3px 8px; font-size: 11px; color: #475569; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); pointer-events: none; }
    .legend-item { display: inline-flex; align-items: center; gap: 4px; font-weight: 500; }
    .legend-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
    .dot-1x { background: #059669; }
    .dot-mid { background: #0d9488; }
    .dot-high { background: #047857; }
    .dot-error { background: #dc2626; }
    .dot-token { background: #d97706; }
    .dot-unvisited { background: #cbd5e1; }
    .diagram-canvas { position: absolute; transform-origin: 0 0; display: inline-block; pointer-events: none; }
    .diagram-canvas img, .diagram-canvas svg { display: block; max-width: none; user-select: none; -webkit-user-drag: none; pointer-events: none; }
    .md-para { margin: 0.3rem 0; line-height: 1.45; }
    .md-para:first-child { margin-top: 0; }
    .md-para:last-child { margin-bottom: 0; }

    /* Table & Badges */
    table { width: 100%; border-collapse: collapse; margin-top: 0.25rem; font-size: 12px; }
    th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #f1f5f9; }
    th { background: #f8fafc; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; border-bottom: 1px solid #e2e8f0; }
    .clickable-row { cursor: pointer; }
    .clickable-row:hover td { background: #f8fafc; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f1f5f9; padding: 0.1em 0.3em; border-radius: 2px; }
    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 0.15em 0.4em; border-radius: 2px; font-family: ui-monospace, monospace; }
    .badge-accent { background: #0f766e; color: white; }
    .badge-turn { background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; }
    .badge-cache { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .badge-dur { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; }
    .badge-cost { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .badge-stop { background: #f1f5f9; color: #475569; }
    .badge-muted { background: #f1f5f9; color: #64748b; }
    .badge-success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .badge-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .badge-pending { background: #fefce8; color: #a16207; border: 1px solid #fef08a; }

    /* Turn Items & Log */
    .turn-item { border-bottom: 1px solid #f1f5f9; padding: 0.85rem 0; transition: background-color 0.2s; }
    .turn-item:last-child { border-bottom: none; }
    .turn-highlight { background-color: #fef3c7 !important; border-radius: 4px; padding-left: 0.5rem; padding-right: 0.5rem; }
    .turn-header { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; margin-bottom: 0.35rem; }
    .turn-index { font-weight: 700; color: #0f172a; margin-right: 0.4rem; }
    .turn-title { font-weight: 600; color: #1e293b; margin-right: 0.4rem; }
    .turn-harness { font-size: 11px; color: #64748b; }
    .turn-meta { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
    .turn-summary { background: #f8fafc; border-radius: 2px; padding: 0.5rem 0.75rem; font-size: 12px; color: #334155; margin-top: 0.35rem; white-space: pre-wrap; border-left: 2px solid #cbd5e1; }
    .turn-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 2px; padding: 0.5rem 0.75rem; font-size: 12px; margin-top: 0.35rem; }
    .tool-tags { display: flex; gap: 0.25rem; flex-wrap: wrap; margin-top: 0.35rem; }
    .tool-tag { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-family: monospace; font-size: 11px; padding: 0.1rem 0.35rem; border-radius: 2px; }

    /* Turn Filter Toolbar */
    .turn-filter-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem; background: #f8fafc; padding: 0.4rem 0.6rem; border-radius: 4px; border: 1px solid #e2e8f0; }
    .filter-btn-group { display: flex; gap: 0.25rem; }
    .filter-btn { background: white; border: 1px solid #cbd5e1; border-radius: 3px; padding: 0.2rem 0.5rem; font-size: 11px; font-weight: 600; color: #475569; cursor: pointer; transition: all 0.15s; }
    .filter-btn:hover { background: #f1f5f9; color: #0f172a; }
    .filter-btn.active { background: #0f766e; color: white; border-color: #0f766e; }
    .search-wrapper { flex: 1; max-width: 280px; min-width: 160px; }
    .search-input { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 3px; padding: 0.25rem 0.5rem; font-size: 11px; }

    /* Collapsible Details in Turn Log */
    .detail-box { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 3px; margin-top: 0.35rem; overflow: hidden; font-size: 12px; }
    .detail-summary { padding: 0.35rem 0.6rem; cursor: pointer; font-weight: 600; color: #334155; user-select: none; display: flex; align-items: center; gap: 0.4rem; justify-content: space-between; background: #f8fafc; font-size: 12px; }
    .detail-summary:hover { background: #f1f5f9; }
    .detail-body { padding: 0.5rem 0.75rem; border-top: 1px solid #f1f5f9; background: #ffffff; }
    .detail-subheading { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 0.25rem; margin-top: 0.35rem; }
    .code-block { margin: 0 0 0.4rem 0; padding: 0.5rem 0.65rem; background: #0f172a; color: #f8fafc; border-radius: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; max-height: 350px; overflow-y: auto; }
    .code-block code { background: transparent; color: inherit; padding: 0; font-size: inherit; font-family: inherit; }
    .code-block:last-child { margin-bottom: 0; }
    .code-error { background: #450a0a; color: #fecaca; }
    .btn-copy { background: transparent; border: 1px solid #cbd5e1; border-radius: 2px; padding: 0.1rem 0.35rem; font-size: 11px; cursor: pointer; color: #475569; transition: all 0.15s; }
    .btn-copy:hover { background: #e2e8f0; color: #0f172a; }

    /* Tool Specific Formatters */
    .tool-details-container { margin-top: 0.5rem; }
    .section-subtitle { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; margin-bottom: 0.25rem; }
    .tool-name-badge { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-family: monospace; font-size: 11px; padding: 0.1rem 0.35rem; border-radius: 2px; font-weight: bold; }
    .tool-id-label { font-family: monospace; font-size: 11px; color: #64748b; }
    .tool-dur { font-size: 11px; color: #64748b; font-family: monospace; }
    .terminal-card { background: #0f172a; border-radius: 3px; overflow: hidden; margin-bottom: 0.4rem; border: 1px solid #1e293b; }
    .terminal-bar { display: flex; align-items: center; justify-content: space-between; padding: 0.25rem 0.6rem; background: #1e293b; border-bottom: 1px solid #334155; font-size: 11px; color: #94a3b8; font-family: monospace; }
    .terminal-title { font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .terminal-card .code-block { background: #0f172a; color: #38bdf8; margin: 0; padding: 0.5rem 0.75rem; }
    .terminal-card .code-block code { color: #38bdf8; background: transparent; padding: 0; }
    .terminal-cmd { margin: 0; padding: 0.5rem 0.75rem; color: #38bdf8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
    .file-path-badge { font-size: 12px; font-weight: 600; color: #1e293b; margin-bottom: 0.35rem; }
    .diff-container { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 3px; margin-bottom: 0.4rem; overflow: hidden; }
    .diff-title { font-size: 11px; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 0.2rem 0.5rem; border-bottom: 1px solid #e2e8f0; }
    .diff-chunk { padding: 0.3rem 0.6rem; font-family: ui-monospace, monospace; font-size: 11.5px; white-space: pre-wrap; line-height: 1.35; }
    .diff-chunk pre { margin: 0; font-family: inherit; font-size: inherit; }
    .diff-old { background: #fef2f2; color: #991b1b; border-left: 2px solid #ef4444; }
    .diff-new { background: #f0fdf4; color: #166534; border-left: 2px solid #22c55e; }

    /* Revisions */
    .revisions-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .revision-item { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 3px; padding: 0.5rem 0.75rem; font-size: 12px; }
    .revision-header { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 0.15rem; font-size: 12px; }
    .revision-time { font-size: 11px; color: #64748b; font-weight: normal; }
    .revision-reason { font-size: 12px; color: #334155; }
    .revision-added { font-family: monospace; font-size: 11px; color: #0f766e; margin-top: 0.15rem; }
    .alert { padding: 0.75rem 1rem; border-radius: 4px; margin-bottom: 1rem; font-size: 12px; }
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
    <div class="metric-box"><div class="metric-val">${totalToolCallsCount}</div><div class="metric-lbl">Tool Invocations</div></div>
    <div class="metric-box"><div class="metric-val">${formatTokens(detail.stats?.totalTokens || 0)}</div><div class="metric-lbl">Tokens</div></div>
    <div class="metric-box"><div class="metric-val">${Math.round((detail.stats?.cacheHitRatio || 0) * 100)}%</div><div class="metric-lbl">Cache Hit</div></div>
    <div class="metric-box"><div class="metric-val">${durationStr}</div><div class="metric-lbl">Duration</div></div>
  </div>

  ${promptHtml}

  <div class="card">
    <h2>Execution Diagrams</h2>
    ${diagramSectionHtml}
  </div>

  <div class="card">
    <h2>Activity Breakdown</h2>
    <table>
      <thead>
        <tr><th>Activity</th><th>Symbol</th><th>Harness</th><th>Turns</th><th>Tokens (In / Out / Cache)</th><th>Reasoning</th><th>Cost ($ USD)</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${computeActivitySummaries(itemsToReport).map(a => `
          <tr class="clickable-row" onclick="scrollToTurn(${a.turnIndices[0]})" title="Click to view turn in log">
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
    <h2 style="margin-top: 0; margin-bottom: 0.75rem;">Chronological Execution Log & Transcript</h2>
    
    <div class="turn-filter-bar">
      <div class="filter-btn-group">
        <button type="button" class="filter-btn active" data-filter="all">All (${itemsToReport.length})</button>
        <button type="button" class="filter-btn" data-filter="tools">Tool Calls (${itemsToReport.filter(t => (t.toolCallDetails?.length || t.toolCalls?.length || 0) > 0).length})</button>
        <button type="button" class="filter-btn" data-filter="errors">Errors (${errorCount})</button>
      </div>
      <div class="search-wrapper">
        <input type="text" id="turn-search-input" class="search-input" placeholder="Search turns, tools, commands..." />
      </div>
      <div>
        <button type="button" class="btn-tool" id="btn-toggle-all-details" data-expanded="${isVerbose ? "true" : "false"}">
          ${isVerbose ? "Collapse All Details" : "Expand All Details"}
        </button>
      </div>
    </div>

    ${turnLogHtml}
  </div>

  ${revisionsHtml}

  <script>
    // Copy button handlers
    document.querySelectorAll('.btn-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = btn.dataset.copy;
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            const orig = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => btn.textContent = orig, 1500);
          });
        }
      });
    });

    // Expand/collapse all details
    const toggleBtn = document.getElementById('btn-toggle-all-details');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const isExpanded = toggleBtn.dataset.expanded === 'true';
        const details = document.querySelectorAll('.turn-item details.detail-box');
        details.forEach(d => d.open = !isExpanded);
        toggleBtn.dataset.expanded = isExpanded ? 'false' : 'true';
        toggleBtn.textContent = isExpanded ? 'Expand All Details' : 'Collapse All Details';
      });
    }

    // Scroll to turn
    window.scrollToTurn = function(index) {
      const el = document.getElementById('turn-' + index);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('turn-highlight');
        setTimeout(() => el.classList.remove('turn-highlight'), 2000);
      }
    };

    // Filter and search
    const filterBtns = document.querySelectorAll('.filter-btn');
    const searchInput = document.getElementById('turn-search-input');

    let currentFilter = 'all';
    let searchQuery = '';

    function applyFilterAndSearch() {
      document.querySelectorAll('.turn-item').forEach(item => {
        const hasTools = item.classList.contains('has-tools');
        const hasError = item.classList.contains('has-error');
        const textContent = item.textContent.toLowerCase();

        let matchesFilter = true;
        if (currentFilter === 'tools' && !hasTools) matchesFilter = false;
        if (currentFilter === 'errors' && !hasError) matchesFilter = false;

        let matchesSearch = true;
        if (searchQuery && !textContent.includes(searchQuery)) matchesSearch = false;

        item.style.display = (matchesFilter && matchesSearch) ? 'block' : 'none';
      });
    }

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        applyFilterAndSearch();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        applyFilterAndSearch();
      });
    }

    // Diagram Tab switching
    document.querySelectorAll('.diagram-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.tabTarget;
        document.querySelectorAll('.diagram-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.diagram-tab-pane').forEach(p => {
          p.classList.remove('active');
          p.style.display = 'none';
        });
        btn.classList.add('active');
        const targetPane = document.getElementById(targetId);
        if (targetPane) {
          targetPane.classList.add('active');
          targetPane.style.display = 'block';
          const viewer = targetPane.querySelector('.diagram-viewer');
          if (viewer && viewer._fitDiagram) viewer._fitDiagram();
        }
      });
    });

    // Pointer-capture Pan and Zoom for Diagram Viewers
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
        const scaleX = (vRect.width - 24) / iWidth;
        const scaleY = (vRect.height - 24) / iHeight;
        scale = Math.min(scaleX, scaleY, 1.2);
        translateX = Math.max(12, (vRect.width - iWidth * scale) / 2);
        translateY = Math.max(12, (vRect.height - iHeight * scale) / 2);
        updateTransform();
      }

      viewer._fitDiagram = fitDiagram;

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

      // Pointer Capture pan dragging (eliminates stuck dragging & ghost images)
      viewport.addEventListener('dragstart', (e) => e.preventDefault());
      viewport.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        isPanning = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
        try { viewport.setPointerCapture(e.pointerId); } catch {}
        viewport.style.cursor = 'grabbing';
      });

      viewport.addEventListener('pointermove', (e) => {
        if (!isPanning) return;
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
      });

      const stopPan = (e) => {
        if (isPanning) {
          isPanning = false;
          try { viewport.releasePointerCapture(e.pointerId); } catch {}
          viewport.style.cursor = 'grab';
        }
      };

      viewport.addEventListener('pointerup', stopPan);
      viewport.addEventListener('pointercancel', stopPan);

      // Double-click to toggle fit / 100%
      viewport.addEventListener('dblclick', () => {
        if (Math.abs(scale - 1) < 0.1) {
          fitDiagram();
        } else {
          scale = 1;
          translateX = 16;
          translateY = 16;
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
        translateX = 16;
        translateY = 16;
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
    verbose?: boolean;
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
      verbose: flags.verbose,
    });
  } else {
    output = await generateMarkdownReport(detail, {
      embedSvg: flags.embedSvg,
      embedDataUri: flags.embedDataUri,
      imageFormat: flags.imageFormat === "svg" ? "svg" : "png",
      scale: flags.scale,
      verbose: flags.verbose,
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
