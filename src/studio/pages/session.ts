import { $, escapeHtml } from "../../js/lib/dom";
import { fitDiagram, wireZoomControls } from "../../js/lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../../js/lib/bpmn-types";
import type { FormInstance } from "../../js/types/globals";
import { connectStudioEvents } from "./live";
import { mountShell, statusChip } from "./shell";
import type { PendingGateInfo, SessionDetail, ToolCallDetail, TurnRecord } from "../types";
import {
  computeActivitySummaries,
  formatCost,
  formatTokens,
  sessionDurationMs,
  sessionItems,
  sessionToolCallCount,
} from "../../session/presentation";
import { definitionPath, inspectBpmnDefinitions, type BpmnDefinitionInfo } from "../../js/lib/bpmn-definitions";

let viewer: BpmnDiagramInstance | null = null;
let renderedGraph: string | null = null;
let markedElements: Array<{ id: string; marker: string }> = [];

let modeler: BpmnDiagramInstance | null = null;
let editing = false;
let latestDetail: SessionDetail | null = null;
let definitions: BpmnDefinitionInfo[] = [];
let activeProcessId = "";
let diagramOpen = true;
/**
 * The revision count read when edit mode was entered -- sent back as
 * `If-Match` on save (issue #76). Captured once, not re-read from
 * `latestDetail` at save time: `refresh()` keeps updating `latestDetail` from
 * its poll even while `editing`, so re-reading it there would defeat the
 * whole point of checking against what was actually loaded.
 */
let editingBaseRevision = 0;

/** One form-js instance per currently-rendered pending gate, keyed by activity id -- never recreated on refresh, so mid-answer input survives a websocket-triggered poll. */
const pendingForms = new Map<string, FormInstance>();

const sessionId = new URLSearchParams(location.search).get("id") ?? "";

function setDiagramOpen(open: boolean): void {
  diagramOpen = open;
  const pane = $("diagram-pane");
  const toggle = $("diagram-toggle");
  pane?.classList.toggle("diagram-open", open);
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide diagram" : "Show diagram";
  }
  if (open) {
    window.setTimeout(() => {
      if (viewer) {
        viewer.get("canvas").resized();
        fitDiagram(viewer);
      }
    }, 0);
  }
}

/**
 * Where the token stands, and where it has been. Markers are cleared first: the
 * graph mutates between revisions, so yesterday's markers may point at elements
 * that no longer exist.
 */
function paintTokens(detail: SessionDetail): void {
  if (!viewer) return;
  const canvas = viewer.get("canvas");
  for (const { id, marker } of markedElements) {
    try {
      canvas.removeMarker(id, marker);
    } catch {
      // element gone in a later revision; nothing to clear
    }
  }
  markedElements = [];

  const mark = (ids: string[], marker: string): void => {
    for (const id of ids) {
      try {
        canvas.addMarker(id, marker);
        markedElements.push({ id, marker });
      } catch {
        // spliced out since this turn ran
      }
    }
  };

  const executionCount = new Map<string, number>();
  let toolCallTurns = 0;
  for (const turn of detail.turns || []) {
    executionCount.set(turn.activityId, (executionCount.get(turn.activityId) || 0) + 1);
    if ((turn.toolCallDetails?.length || turn.toolCalls?.length || 0) > 0) toolCallTurns += 1;
  }
  const totalTurns = detail.turns?.length || 0;
  const repeated = (ids: string[], count: number): void => {
    for (const id of ids) if (detail.visited.includes(id)) executionCount.set(id, count);
  };
  repeated(["inject_pending", "gw_inject_entry", "gw_failed", "gw_tools", "agent_loop"], totalTurns || 1);
  repeated(["gw_truncated", "tool_batch", "collect_tools", "gw_settled", "prepare_next", "next_turn"], toolCallTurns);
  repeated(["drain_followup", "gw_followup", "agent_done", "loop_start", "session_start"], 1);

  const visited = new Set(detail.visited || []);
  const markerForCount = (count: number): string => {
    return count >= 5 ? "ga-visited-high" : count >= 2 ? "ga-visited-mid" : "ga-visited";
  };
  const markerFor = (id: string): string => markerForCount(executionCount.get(id) || 1);
  for (const id of visited) mark([id], markerFor(id));

  const failed = new Set((detail.turns || []).filter((turn) => turn.stopReason === "error" || turn.error).map((turn) => turn.activityId));
  mark([...failed], "ga-error");

  // Highlight the completed route, not just the nodes that carried agent work.
  for (const shape of viewer.get("elementRegistry").getAll() as Array<any>) {
    if (shape?.type === "bpmn:CallActivity" && shape.businessObject?.calledElement && definitions.some((definition) => definition.processId === shape.businessObject.calledElement)) {
      mark([shape.id], "ga-drillable");
    }
    if (shape?.type === "bpmn:SequenceFlow") {
      const sourceId = shape.source?.id;
      const targetId = shape.target?.id;
      if (sourceId && targetId && visited.has(sourceId) && visited.has(targetId)) {
        mark([shape.id], markerForCount(Math.min(executionCount.get(sourceId) || 1, executionCount.get(targetId) || 1)));
      }
    } else if (shape?.type === "bpmn:Lane" || shape?.type === "bpmn:Participant") {
      if ((shape.children || []).some((child: any) => visited.has(child.id))) mark([shape.id], "ga-visited-lane");
    }
  }
  mark(detail.tokens, "ga-token");
  paintOverlays(detail);
}

function paintOverlays(detail: SessionDetail): void {
  if (!viewer) return;
  const overlays = viewer.get("overlays") as any;
  try {
    overlays.clear();
  } catch {}
  if (!detail.turns?.length) return;

  const activityCosts = new Map<string, { cost: number; turns: number; durationMs: number }>();
  for (const turn of detail.turns) {
    const prev = activityCosts.get(turn.activityId) || { cost: 0, turns: 0, durationMs: 0 };
    prev.cost += turn.usage?.cost?.total ?? 0;
    prev.turns += 1;
    if (turn.startedAt && turn.endedAt) prev.durationMs += turn.endedAt - turn.startedAt;
    activityCosts.set(turn.activityId, prev);
  }

  for (const [activityId, stat] of activityCosts) {
    try {
      const costFormatted = stat.cost > 0 ? formatCost(stat.cost) : `${stat.turns} turn${stat.turns === 1 ? "" : "s"}`;
      overlays.add(activityId, "cost-badge", {
        position: { bottom: 0, right: 0 },
        html: `<div class="font-mono text-[9px] px-1 py-0.5 rounded bg-accent text-white font-bold shadow-md cursor-pointer pointer-events-auto" title="${stat.turns} turn(s), ${formatCost(stat.cost)}">${costFormatted}</div>`,
      });
    } catch {}
  }
}

let currentTurnFilter: "all" | "tools" | "errors" = "all";
let currentTurnSearch = "";
let allDetailsExpanded = false;

function formatTurnRange(indices: number[]): string {
  if (indices.length === 0) return "";
  if (indices.length === 1) return `T${indices[0]}`;
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1]! + 1);
  if (isContiguous) {
    return `T${indices[0]}..T${indices[indices.length - 1]}`;
  }
  return indices.map((i) => `T${i}`).join(",");
}

function renderMarkdownToHtml(md: string): string {
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
    return `<div class="my-1">${p}</div>`;
  }).join("");

  return paragraphs.replace(/___CODE_BLOCK_(\d+)___/g, (_m, idx) => codeBlocks[Number(idx)] || "");
}

function formatToolCallHtml(tc: ToolCallDetail, isExpanded: boolean): string {
  const statusBadge = tc.result
    ? (tc.result.isError ? `<span class="badge failed">failed</span>` : `<span class="badge completed">ok</span>`)
    : `<span class="badge waiting_human">pending</span>`;
  const durStr = tc.durationMs ? `<span class="font-mono text-[10px] text-muted">${(tc.durationMs / 1000).toFixed(2)}s</span>` : "";

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
      <div class="mt-1">
        <div class="detail-subheading">Output ${tc.result ? (tc.result.isError ? "(Error)" : "(Success)") : ""}:</div>
        <pre class="code-block ${tc.result?.isError ? 'code-error' : ''}">${escapeHtml(tc.result?.content || '(no output)')}</pre>
      </div>
    `;
  } else if (tc.name === "edit" && tc.arguments?.path) {
    const path = String(tc.arguments.path);
    const edits = Array.isArray(tc.arguments.edits) ? tc.arguments.edits : [];
    let diffHtml = "";
    if (edits.length > 0) {
      diffHtml = edits.map((e: any, idx: number) => `
        <div class="diff-container">
          <div class="diff-title">Replacement #${idx + 1}</div>
          ${e.oldText ? `<div class="diff-chunk diff-old"><pre>${escapeHtml(e.oldText)}</pre></div>` : ""}
          ${e.newText ? `<div class="diff-chunk diff-new"><pre>${escapeHtml(e.newText)}</pre></div>` : ""}
        </div>
      `).join("");
    }
    bodyHtml = `
      <div class="font-mono text-[11px] font-semibold text-ink mb-1">File: <code>${escapeHtml(path)}</code></div>
      ${diffHtml}
      <div class="mt-1">
        <div class="detail-subheading">Result:</div>
        <pre class="code-block">${escapeHtml(tc.result?.content || 'ok')}</pre>
      </div>
    `;
  } else if ((tc.name === "read" || tc.name === "write") && tc.arguments?.path) {
    const path = String(tc.arguments.path);
    const writeContent = tc.name === "write" && typeof tc.arguments.content === "string" ? tc.arguments.content : "";
    bodyHtml = `
      <div class="font-mono text-[11px] font-semibold text-ink mb-1">File: <code>${escapeHtml(path)}</code> <span class="badge">${escapeHtml(tc.name)}</span></div>
      ${writeContent ? `<div class="detail-subheading">Written Content:</div><pre class="code-block">${escapeHtml(writeContent)}</pre>` : ""}
      <div class="mt-1">
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
    <details class="detail-box tool-card" ${isExpanded ? "open" : ""}>
      <summary class="detail-summary">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="font-mono font-bold text-[10px] px-1 py-0.5 rounded bg-sky-dim text-sky border border-sky-border">${escapeHtml(tc.name)}</span>
          <span class="font-mono text-[10px] text-muted truncate">${escapeHtml(tc.id)}</span>
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

function usageChip(turn: TurnRecord): string {
  if (!turn.usage) return "";
  const { input, output, cacheRead } = turn.usage;
  const cost = turn.usage.cost?.total ? ` · ${formatCost(turn.usage.cost.total)}` : "";
  const cached = cacheRead > 0;
  return `<span class="font-mono text-[10px] px-1 py-0.5 rounded border ${
    cached ? "text-accent border-accent-border bg-accent-dim" : "text-muted border-line bg-panel-header"
  }" title="input ${input}, output ${output}, cache read ${cacheRead}">${cached ? `cache ${cacheRead}` : "uncached"}${cost}</span>`;
}

function renderActivities(turns: TurnRecord[]): void {
  const host = $("activities");
  if (!host) return;
  const map = computeActivitySummaries(turns);

  if (map.length === 0) {
    host.innerHTML = `<p class="px-3 py-4 text-muted">No activities executed yet.</p>`;
    return;
  }

  host.innerHTML = `
    <table class="w-full text-left border-collapse text-[11px]">
      <thead>
        <tr class="border-b border-line text-muted">
          <th class="py-1.5 px-2 font-semibold">Activity</th>
          <th class="py-1.5 px-1 font-semibold text-center">Range</th>
          <th class="py-1.5 px-1 font-semibold text-center">Turns</th>
           <th class="py-1.5 px-2 font-semibold">In / Out / Cache / Reasoning</th>
          <th class="py-1.5 px-2 font-semibold text-right">Cost</th>
        </tr>
      </thead>
      <tbody>
        ${map
          .map(
            (act) => `
            <tr class="border-b border-line-subtle hover:bg-card-hover cursor-pointer" data-activity="${escapeHtml(act.activityId)}" data-first-turn="${act.turnIndices[0]}">
            <td class="py-1.5 px-2">
              <div class="font-medium text-ink truncate max-w-[110px]" title="${escapeHtml(act.activityName)}">${escapeHtml(act.activityName)}</div>
              <div class="font-mono text-[9.5px] text-muted truncate max-w-[110px]">${escapeHtml(act.harness)}</div>
            </td>
            <td class="py-1.5 px-1 font-mono text-[10px] text-center text-muted">${formatTurnRange(act.turnIndices) || "-"}</td>
            <td class="py-1.5 px-1 font-mono text-[10px] text-center">${act.turns}</td>
            <td class="py-1.5 px-2 font-mono text-[9.5px] text-muted whitespace-nowrap">
              ${formatTokens(act.inputTokens)} / ${formatTokens(act.outputTokens)} / ${formatTokens(act.cacheReadTokens)} / ${formatTokens(act.reasoningTokens)}
            </td>
            <td class="py-1.5 px-2 font-mono text-[10px] text-right font-bold text-accent">${formatCost(act.costUSD)}<br><span class="text-muted font-normal">${act.durationMs > 0 ? `${(act.durationMs / 1000).toFixed(1)}s` : "-"}</span></td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;

  for (const row of host.querySelectorAll<HTMLElement>("tr[data-activity]")) {
    row.onclick = () => {
      const id = row.dataset.activity;
      if (!id || !viewer) return;
      try {
        const element = viewer.get("elementRegistry").get(id);
        if (element) viewer.get("canvas").scrollToElement(element);
      } catch {}
      const firstTurn = row.dataset.firstTurn;
      if (firstTurn !== undefined) {
        const turnEl = document.getElementById(`turn-${firstTurn}`);
        if (turnEl) {
          turnEl.scrollIntoView({ behavior: "smooth", block: "center" });
          turnEl.classList.add("turn-highlight");
          setTimeout(() => turnEl.classList.remove("turn-highlight"), 2000);
        }
      }
    };
  }
}

function wireCopyButtons(container: HTMLElement): void {
  for (const btn of container.querySelectorAll<HTMLButtonElement>(".btn-copy")) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const text = btn.dataset.copy;
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          const orig = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = orig), 1500);
        });
      }
    };
  }
}

function renderTurns(turns: TurnRecord[]): void {
  const host = $("turns");
  if (!host) return;
  if (turns.length === 0) {
    host.innerHTML = `<p class="px-3 py-4 text-muted">No turns yet.</p>`;
    return;
  }

  const query = currentTurnSearch.trim().toLowerCase();

  host.innerHTML = turns
    .map((turn) => {
      const hasTools = (turn.toolCallDetails?.length || 0) > 0 || (turn.toolCalls?.length || 0) > 0;
      const hasError = Boolean(turn.error || turn.stopReason === "error" || turn.toolCallDetails?.some((tc) => tc.result?.isError));

      let matchesFilter = true;
      if (currentTurnFilter === "tools" && !hasTools) matchesFilter = false;
      if (currentTurnFilter === "errors" && !hasError) matchesFilter = false;

      const searchableText = [
        turn.index,
        turn.activityName || "",
        turn.activityId,
        turn.harness || "",
        turn.summary || "",
        turn.prompt || "",
        turn.response || "",
        turn.thinking || "",
        turn.error || "",
        ...(turn.toolCalls || []),
        ...(turn.toolCallDetails?.map((tc) => `${tc.name} ${JSON.stringify(tc.arguments || {})} ${tc.result?.content || ""}`) || []),
      ].join(" ").toLowerCase();

      const matchesSearch = !query || searchableText.includes(query);
      const isVisible = matchesFilter && matchesSearch;

      const tools = turn.toolCallDetails?.length
        ? `<div class="mt-2">
            <div class="detail-subheading">Tool Invocations (${turn.toolCallDetails.length})</div>
            ${turn.toolCallDetails.map((tc) => formatToolCallHtml(tc, allDetailsExpanded)).join("")}
          </div>`
        : turn.toolCalls?.length
        ? `<div class="mt-1 flex flex-wrap gap-1">${turn.toolCalls
            .map(
              (t) =>
                `<span class="font-mono text-[10px] px-1 py-0.5 rounded bg-sky-dim text-sky border border-sky-border">${escapeHtml(t)}</span>`,
            )
            .join("")}</div>`
        : "";

      const promptBlock = turn.prompt
        ? `
          <details class="detail-box" ${allDetailsExpanded ? "open" : ""}>
            <summary class="detail-summary">
              <span><strong>Input Prompt</strong> (${turn.prompt.length} chars)</span>
              <button type="button" class="btn-copy" data-copy="${escapeHtml(turn.prompt)}" title="Copy Prompt">Copy</button>
            </summary>
            <div class="detail-body">
              <pre class="code-block">${escapeHtml(turn.prompt)}</pre>
            </div>
          </details>
        `
        : turn.inputs && Object.keys(turn.inputs).length > 0 && turn.inputs.prompt !== null
        ? `
          <details class="detail-box" ${allDetailsExpanded ? "open" : ""}>
            <summary class="detail-summary">
              <span><strong>Inputs</strong> (${Object.keys(turn.inputs).length} field(s))</span>
            </summary>
            <div class="detail-body">
              <pre class="code-block">${escapeHtml(JSON.stringify(turn.inputs, null, 2))}</pre>
            </div>
          </details>
        `
        : "";

      const thinkingBlock = turn.thinking
        ? `
          <details class="detail-box" ${allDetailsExpanded ? "open" : ""}>
            <summary class="detail-summary">
              <span><strong>Thinking / Reasoning</strong> (${turn.thinking.length} chars)</span>
              <button type="button" class="btn-copy" data-copy="${escapeHtml(turn.thinking)}" title="Copy Thinking">Copy</button>
            </summary>
            <div class="detail-body">
              <pre class="code-block" style="font-style: italic; opacity: 0.9;">${escapeHtml(turn.thinking)}</pre>
            </div>
          </details>
        `
        : "";

      const responseBlock = turn.response && turn.response !== turn.summary
        ? `
          <details class="detail-box" ${allDetailsExpanded ? "open" : ""}>
            <summary class="detail-summary">
              <span><strong>Model Response</strong> (${turn.response.length} chars)</span>
              <button type="button" class="btn-copy" data-copy="${escapeHtml(turn.response)}" title="Copy Response">Copy</button>
            </summary>
            <div class="detail-body">
              <pre class="code-block">${escapeHtml(turn.response)}</pre>
            </div>
          </details>
        `
        : turn.outputs && Object.keys(turn.outputs).length > 0 && !turn.response
        ? `
          <details class="detail-box" ${allDetailsExpanded ? "open" : ""}>
            <summary class="detail-summary">
              <span><strong>Outputs</strong></span>
            </summary>
            <div class="detail-body">
              <pre class="code-block">${escapeHtml(JSON.stringify(turn.outputs, null, 2))}</pre>
            </div>
          </details>
        `
        : "";

      const turnDur = turn.startedAt && turn.endedAt
        ? `<span class="font-mono text-[10px] text-muted">${((turn.endedAt - turn.startedAt) / 1000).toFixed(1)}s</span>`
        : "";

      return `
        <article class="turn-item ${hasTools ? 'has-tools' : ''} ${hasError ? 'has-error' : ''}" id="turn-${turn.index}" data-activity="${escapeHtml(turn.activityId)}" style="${isVisible ? '' : 'display: none;'}">
          <div class="turn-header">
            <div>
              <span class="font-mono font-bold text-[10px] px-1 py-0.5 rounded bg-accent-dim text-accent border border-accent-border mr-1">T${turn.index}</span>
              <span class="font-semibold text-ink">${escapeHtml(turn.activityName || turn.activityId)}</span>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              ${usageChip(turn)}
              ${turnDur}
              ${turn.stopReason ? `<span class="text-[10px] uppercase tracking-wide font-bold text-muted">${escapeHtml(turn.stopReason)}</span>` : ""}
            </div>
          </div>
          <div class="font-mono text-[10px] text-muted">${escapeHtml(turn.activityId)}${turn.harness ? ` &middot; ${escapeHtml(turn.harness)}` : ""}</div>
          ${turn.summary ? `<div class="turn-summary">${renderMarkdownToHtml(turn.summary)}</div>` : ""}
          ${promptBlock}
          ${thinkingBlock}
          ${responseBlock}
          ${tools}
          ${turn.error ? `<div class="turn-error">${escapeHtml(turn.error)}</div>` : ""}
        </article>`;
    })
    .join("");

  wireCopyButtons(host);

  // Clicking a turn centres the node that produced it.
  for (const article of host.querySelectorAll<HTMLElement>("article[data-activity]")) {
    article.onclick = (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("details") || target.closest("button") || target.closest("pre")) return;
      const id = article.dataset.activity;
      if (!id || !viewer) return;
      try {
        const element = viewer.get("elementRegistry").get(id);
        if (element) viewer.get("canvas").scrollToElement(element);
      } catch {
        // element no longer in the current revision
      }
    };
  }
}

function renderRevisions(detail: SessionDetail): void {
  const host = $("revisions");
  if (!host) return;
  if (detail.revisions.length === 0) {
    host.innerHTML = `<p class="px-3 py-3 text-muted">Graph unchanged since the session started.</p>`;
    return;
  }
  host.innerHTML = detail.revisions
    .map(
      (rev) => `
      <div class="px-3 py-2 border-b border-line-subtle">
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-semibold text-ink">r${rev.index}</span>
          <span class="text-[10px] text-muted">${new Date(rev.at).toLocaleTimeString()}</span>
        </div>
        <div class="text-ink-secondary">${escapeHtml(rev.reason)}</div>
        ${
          rev.addedElementIds.length
            ? `<div class="mt-1 font-mono text-[10px] text-accent">+ ${rev.addedElementIds.map(escapeHtml).join(", ")}</div>`
            : ""
        }
      </div>`,
    )
    .join("");
}

function renderDefinitionNavigation(detail: SessionDetail): void {
  const nav = $("definition-navigation");
  const crumbs = $("definition-breadcrumbs");
  if (!nav || !crumbs || definitions.length === 0) return;
  nav.classList.remove("hidden");

  const active = definitions.find((definition) => definition.processId === activeProcessId) || definitions[0]!;
  const path = definitionPath(definitions, active.processId);
  crumbs.innerHTML = path
    .map((definition, index) => `${index > 0 ? `<span aria-hidden="true">/</span>` : ""}<button type="button" data-process="${escapeHtml(definition.processId)}" ${index === path.length - 1 ? "aria-current=page" : ""}>${escapeHtml(definition.name)}</button>`)
    .join("");
  for (const button of crumbs.querySelectorAll<HTMLButtonElement>("button")) {
    button.onclick = () => void openDefinition(button.dataset.process || "", detail);
  }
}

async function openDefinition(processId: string, detail: SessionDetail): Promise<void> {
  if (!viewer || !processId) return;
  const modelDefinitions = viewer.getDefinitions?.();
  if (!modelDefinitions || !viewer.open) return;
  const diagram = modelDefinitions.diagrams?.find((candidate) => candidate.plane?.bpmnElement?.id === processId);
  if (!diagram) return;
  try {
    await viewer.open(diagram);
    activeProcessId = processId;
    renderDefinitionNavigation(detail);
    markedElements = [];
    fitDiagram(viewer);
    paintTokens(detail);
  } catch {
    // A malformed or removed diagram should not take down the live session view.
  }
}

function syncDefinitions(detail: SessionDetail): void {
  if (!viewer) return;
  const modelDefinitions = viewer.getDefinitions?.();
  if (!modelDefinitions) return;
  definitions = inspectBpmnDefinitions(modelDefinitions as never);
  const activeExists = definitions.some((definition) => definition.processId === activeProcessId);
  if (!activeExists) activeProcessId = definitions.find((definition) => definition.isRoot)?.processId || definitions[0]?.processId || "";
  renderDefinitionNavigation(detail);
}

function updateSessionSummary(detail: SessionDetail, turns: TurnRecord[]): void {
  const metrics: Record<string, string> = {
    status: detail.status,
    cost: formatCost(detail.stats?.totalCostUSD || 0),
    turns: String(detail.turnCount),
    tools: String(sessionToolCallCount(turns)),
    tokens: formatTokens(detail.stats?.totalTokens || 0),
    cache: `${Math.round((detail.stats?.cacheHitRatio || 0) * 100)}%`,
    duration: sessionDurationMs(turns) > 0 ? `${(sessionDurationMs(turns) / 1000).toFixed(1)}s` : "-",
  };
  for (const [name, value] of Object.entries(metrics)) {
    const element = $(`metric-${name}`);
    if (element) element.textContent = value;
  }
  const promptCard = $("prompt-card");
  const prompt = $("session-prompt");
  if (promptCard && prompt) {
    promptCard.classList.toggle("hidden", !detail.prompt);
    prompt.textContent = detail.prompt || "";
  }
  const error = $("harness-error");
  if (error) {
    error.classList.toggle("hidden", !detail.harnessError);
    error.textContent = detail.harnessError ? `Harness error: ${detail.harnessError}` : "";
  }
}

async function refresh(): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) {
    const title = $("session-title");
    if (title) title.textContent = "Unknown session";
    return;
  }
  const detail: SessionDetail = await res.json();
  latestDetail = detail;
  const items = sessionItems(detail);
  updateSessionSummary(detail, items);

  const title = $("session-title");
  if (title) title.textContent = detail.name || detail.id;
  const status = $("session-status");
  if (status) status.innerHTML = statusChip(detail.status);

  const costEl = $("session-cost");
  if (costEl) {
    if (detail.stats?.totalCostUSD && detail.stats.totalCostUSD > 0) {
      costEl.textContent = formatCost(detail.stats.totalCostUSD);
      costEl.classList.remove("hidden");
    } else {
      costEl.classList.add("hidden");
    }
  }

  const meta = $("session-meta");
  if (meta) {
    const tokenInfo = detail.stats?.totalTokens
      ? ` · ${Math.round((detail.stats.totalTokens / 1000) * 10) / 10}k tokens (${Math.round(detail.stats.cacheHitRatio * 100)}% cached)`
      : "";
    meta.textContent = `${detail.turnCount} turns · ${detail.revisions.length} graph revision${
      detail.revisions.length === 1 ? "" : "s"
    }${tokenInfo}`;
  }

  // The session graph mutates, so re-import only when the XML actually changed
  // -- and never while a studio edit is in progress, which would yank the
  // diagram out from under whoever is editing it.
  if (viewer && !editing && detail.graph && detail.graph !== renderedGraph) {
    await viewer.importXML(detail.graph);
    renderedGraph = detail.graph;
    markedElements = [];
    syncDefinitions(detail);
    const active = definitions.find((definition) => definition.processId === activeProcessId);
    const diagram = viewer.getDefinitions?.().diagrams?.find((candidate) => candidate.plane?.bpmnElement?.id === active?.processId);
    if (diagram && viewer.open) await viewer.open(diagram);
    fitDiagram(viewer);
  }
  paintTokens(detail);
  renderTurns(items);
  renderActivities(items);
  renderRevisions(detail);
  void refreshPending();
}

/** Sanitized so a `data-gate-id` (unquoted attribute-safe) and an element id can carry an arbitrary activity id. */
function pendingElementId(gateId: string): string {
  return `pending-form-${gateId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Renders every parked human gate as its own form-js instance -- created
 * once and left alone on later refreshes, so a websocket-triggered poll
 * never clobbers input someone is mid-way through answering (issue #51).
 */
async function refreshPending(): Promise<void> {
  const host = $("pending-gates");
  const section = $("pending-section");
  if (!host || !section) return;
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pending`);
  if (!res.ok) return;
  const gates: PendingGateInfo[] = await res.json();

  section.classList.toggle("hidden", gates.length === 0);
  if (gates.length === 0) {
    for (const form of pendingForms.values()) form.destroy();
    pendingForms.clear();
    host.innerHTML = "";
    return;
  }

  const wanted = new Set(gates.map((g) => g.id));
  for (const [id, form] of [...pendingForms]) {
    if (wanted.has(id)) continue;
    form.destroy();
    pendingForms.delete(id);
    $(pendingElementId(id))?.remove();
  }

  for (const gate of gates) {
    const existing = $(pendingElementId(gate.id));
    if (existing) {
      // Leave an in-progress form alone (do not clobber typed input), but a
      // gate answered since it was rendered has nothing left to preserve --
      // swap in the "answered" message so submitting is not silently a no-op
      // from the viewer's own perspective.
      if (gate.answered && existing.dataset.answered !== "true") {
        pendingForms.get(gate.id)?.destroy();
        pendingForms.delete(gate.id);
        existing.dataset.answered = "true";
        for (const el of existing.querySelectorAll(".fjs-host, .answer-btn, .answer-err")) el.remove();
        existing.insertAdjacentHTML(
          "beforeend",
          `<p class="text-accent text-[11px]">Answered -- waiting for the session to resume.</p>`,
        );
      }
      continue;
    }

    const wrapper = document.createElement("div");
    wrapper.id = pendingElementId(gate.id);
    wrapper.className = "px-3 py-3 border-b border-line-subtle";
    wrapper.dataset.answered = String(gate.answered);
    const body = gate.answered
      ? `<p class="text-accent text-[11px]">Answered -- waiting for the session to resume.</p>`
      : gate.form
        ? `<div class="fjs-host mb-2"></div>
           <button class="btn px-2.5 py-1 text-xs answer-btn">Answer</button>
           <p class="hidden mt-1 text-danger text-[11px] answer-err"></p>`
        : `<p class="text-muted text-[11px]">No form defined for this gate. Answer it from a terminal:
           <code class="block mt-1 font-mono text-[10px] break-all">graph-agent resume ${escapeHtml(sessionId)} --answer ${escapeHtml(gate.id)}:key=value</code></p>`;
    wrapper.innerHTML = `
      <div class="font-semibold text-ink mb-1">${escapeHtml(gate.name || gate.id)}</div>
      ${gate.documentation ? `<p class="text-ink-secondary text-[11px] mb-2">${escapeHtml(gate.documentation)}</p>` : ""}
      ${body}`;
    host.appendChild(wrapper);

    if (gate.answered || !gate.form) continue;
    const FormCtor = window.FormViewer?.Form ?? window.FormJS?.Form;
    if (!FormCtor) continue;
    const form = new FormCtor({ container: wrapper.querySelector(".fjs-host") as HTMLElement });
    pendingForms.set(gate.id, form);
    try {
      await form.importSchema(JSON.parse(gate.form.schema));
    } catch {
      wrapper.querySelector(".fjs-host")?.replaceWith(
        Object.assign(document.createElement("p"), {
          className: "text-danger text-[11px]",
          textContent: "This gate's form schema is not valid JSON.",
        }),
      );
      continue;
    }

    const errEl = wrapper.querySelector<HTMLElement>(".answer-err");
    const answerBtn = wrapper.querySelector<HTMLButtonElement>(".answer-btn");
    if (answerBtn) {
      answerBtn.onclick = async () => {
        const { data, errors } = form.submit();
        if (Object.keys(errors).length > 0) {
          if (errEl) {
            errEl.textContent = "Fix the highlighted field(s) before answering.";
            errEl.classList.remove("hidden");
          }
          return;
        }
        answerBtn.disabled = true;
        const submitRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ activityId: gate.id, payload: data }),
        });
        if (!submitRes.ok) {
          answerBtn.disabled = false;
          if (errEl) {
            errEl.textContent = "Could not queue the answer.";
            errEl.classList.remove("hidden");
          }
          return;
        }
        void refreshPending();
      };
    }
  }
}

function editMsg(message: string, tone: "ok" | "error" | "info" | "none" = "none"): void {
  const host = $("edit-msg");
  if (!host) return;
  host.classList.toggle("hidden", tone === "none");
  host.className =
    tone === "none"
      ? "hidden"
      : tone === "ok"
        ? "mb-2 p-2 rounded-md text-xs bg-accent-dim text-accent border border-accent-border"
        : tone === "info"
          ? "mb-2 p-2 rounded-md text-xs bg-sky-dim text-sky border border-sky-border"
          : "mb-2 p-2 rounded-md text-xs bg-danger-dim text-danger border border-danger-border";
  host.textContent = message;
}

/** Elements the token has visited or currently stands on -- checkMigration rejects removing or renaming any of these. */
function liveIds(detail: SessionDetail): Set<string> {
  return new Set([...detail.visited, ...detail.tokens]);
}

async function ensureModeler(): Promise<BpmnDiagramInstance | null> {
  if (modeler) return modeler;
  const ModelerCtor = window.BpmnModeler || window.BpmnJS;
  if (!ModelerCtor) return null;
  modeler = new (
    ModelerCtor as new (options: {
      container: string;
      propertiesPanel?: { parent: string };
      additionalModules?: unknown[];
      moddleExtensions?: Record<string, unknown>;
      linting?: { bpmnlint: { config: { rules: Record<string, string> }; resolver: unknown }; active: boolean };
      elementTemplateIconRenderer?: { iconProperty: string };
    }) => BpmnDiagramInstance
  )({
    container: "#editor",
    propertiesPanel: { parent: "#properties-panel" },
    additionalModules: [
      window.BpmnPropertiesPanelModule,
      window.BpmnPropertiesProviderModule,
      window.ElementTemplatesPropertiesProviderModule,
      window.minimapModule,
      window.CreateAppendAnythingModule,
      window.CreateAppendElementTemplatesModule,
      window.BpmnlintModule,
      window.ElementTemplateChooserModule,
      window.ElementTemplateIconRendererModule,
      window.ElementTemplatesExtendModule,
    ].filter(Boolean),
    moddleExtensions: { zeebe: window.zeebeModdleDescriptor || {} },
    linting: window.BpmnlintRecommendedConfig
      ? { bpmnlint: window.BpmnlintRecommendedConfig, active: true }
      : undefined,
    elementTemplateIconRenderer: { iconProperty: "zeebe:modelerTemplateIcon" },
  });
  try {
    const res = await fetch("/api/element-templates");
    if (res.ok) modeler.get("elementTemplatesLoader").setTemplates(await res.json());
  } catch {
    // element templates are optional; the editor works without them
  }
  // Exposed so scripts/verify-editor.mjs (and anything else driving the page)
  // can reach the modeler without scraping internals off the DOM -- the same
  // hook graph.ts's editor already provides.
  (window as unknown as { __modeler?: unknown }).__modeler = modeler;
  return modeler;
}

/** Marks every live element so an edit is at least visually warned before it is attempted -- checkMigration is the actual enforcement. */
function markLocked(instance: BpmnDiagramInstance, ids: Set<string>): void {
  const canvas = instance.get("canvas");
  for (const id of ids) {
    try {
      canvas.addMarker(id, "ga-locked");
    } catch {
      // not in this revision
    }
  }
}

async function enterEdit(): Promise<void> {
  if (!latestDetail) return;
  const instance = await ensureModeler();
  if (!instance) return editMsg("Editor failed to load.", "error");

  editing = true;
  setDiagramOpen(true);
  editingBaseRevision = latestDetail.revisions.length;
  $("viewer")?.classList.add("hidden");
  $("editor")?.classList.remove("hidden");
  $("properties-container")?.classList.remove("hidden");
  $("properties-container")?.classList.add("flex");
  $("edit-btn")?.classList.add("hidden");
  $("save-btn")?.classList.remove("hidden");
  $("cancel-btn")?.classList.remove("hidden");
  // `detail.status` is already `effectiveStatus` (session-store.ts), so a
  // killed process's session reports "stale" here, not "running" -- this
  // banner only appears for a genuinely live driving process (issue #76).
  if (latestDetail.status === "running") {
    editMsg(
      "This session is currently running. If it is still driving when you save, your edit is accepted and picked up automatically at the next activity boundary rather than refused.",
      "info",
    );
  } else {
    editMsg("", "none");
  }

  await instance.importXML(latestDetail.graph);
  markLocked(instance, liveIds(latestDetail));
  fitDiagram(instance);
}

function exitEdit(): void {
  editing = false;
  setDiagramOpen(!window.matchMedia("(max-width: 1023px)").matches);
  $("editor")?.classList.add("hidden");
  $("properties-container")?.classList.add("hidden");
  $("properties-container")?.classList.remove("flex");
  $("viewer")?.classList.remove("hidden");
  $("edit-btn")?.classList.remove("hidden");
  $("save-btn")?.classList.add("hidden");
  $("cancel-btn")?.classList.add("hidden");
  // Force the viewer to pick up whatever is now current, including a save
  // that just landed.
  renderedGraph = null;
  void refresh();
}

async function saveEdit(): Promise<void> {
  if (!modeler) return;
  const { xml } = await modeler.saveXML({ format: true });
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/graph`, {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": String(editingBaseRevision) },
    body: JSON.stringify({ xml }),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { error?: string; removed?: string[]; conflict?: string };
    editMsg(
      body.conflict === "stale"
        ? `${body.error ?? "Cannot save: someone else's edit landed first"} Reopen the editor to reload it.`
        : body.removed?.length
          ? `Cannot save: ${body.error} (${body.removed.join(", ")})`
          : (body.error ?? "Cannot save: rejected"),
      "error",
    );
    return;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    editMsg(`Save failed: ${body.error ?? res.statusText}`, "error");
    return;
  }
  const body = (await res.json()) as { revisions: number; note?: string };
  editMsg(body.note ? `Saved as a new revision. ${body.note}.` : "Saved as a new revision.", "ok");
  exitEdit();
}

async function init(): Promise<void> {
  await mountShell("session");
  setDiagramOpen(!window.matchMedia("(max-width: 1023px)").matches);

  const ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  if (ViewerCtor) {
    viewer = new (ViewerCtor as new (options: {
      container: string;
      additionalModules?: unknown[];
    }) => BpmnDiagramInstance)({
      container: "#viewer",
      additionalModules: [window.minimapModule].filter(Boolean),
    });

    wireZoomControls(() => viewer, {
      zoomIn: "ctrl-zoom-in",
      zoomOut: "ctrl-zoom-out",
      fit: "ctrl-zoom-fit",
      reset: "ctrl-zoom-reset",
      minimap: "ctrl-minimap",
    });
    viewer.on("element.click", (event) => {
      const clicked = (event as { element?: { type?: string; businessObject?: { calledElement?: string } } }).element;
      if (clicked?.type !== "bpmn:CallActivity" || !clicked.businessObject?.calledElement || !latestDetail) return;
      if (definitions.some((definition) => definition.processId === clicked.businessObject!.calledElement)) {
        void openDefinition(clicked.businessObject.calledElement, latestDetail);
      }
    });
  }

  await refresh();

  const diagramToggle = $("diagram-toggle");
  if (diagramToggle) diagramToggle.onclick = () => setDiagramOpen(!diagramOpen);

  const editBtn = $("edit-btn");
  if (editBtn) editBtn.onclick = () => void enterEdit();
  const cancelBtn = $("cancel-btn");
  if (cancelBtn) cancelBtn.onclick = () => exitEdit();
  const saveBtn = $("save-btn");
  if (saveBtn) saveBtn.onclick = () => void saveEdit();

  const tabTurns = $("tab-btn-turns");
  const tabActivities = $("tab-btn-activities");
  const turnsHost = $("turns");
  const activitiesHost = $("activities");

  if (tabTurns && tabActivities && turnsHost && activitiesHost) {
    tabTurns.onclick = () => {
      tabTurns.className = "text-[11.5px] font-bold tracking-wider uppercase text-accent border-b-2 border-accent pb-0.5";
      tabActivities.className = "text-[11.5px] font-bold tracking-wider uppercase text-muted hover:text-ink pb-0.5";
      turnsHost.classList.remove("hidden");
      activitiesHost.classList.add("hidden");
    };
    tabActivities.onclick = () => {
      tabActivities.className = "text-[11.5px] font-bold tracking-wider uppercase text-accent border-b-2 border-accent pb-0.5";
      tabTurns.className = "text-[11.5px] font-bold tracking-wider uppercase text-muted hover:text-ink pb-0.5";
      activitiesHost.classList.remove("hidden");
      turnsHost.classList.add("hidden");
    };
  }

  const expandBtn = $("btn-toggle-expand-all");
  if (expandBtn) {
    expandBtn.onclick = () => {
      allDetailsExpanded = !allDetailsExpanded;
      expandBtn.textContent = allDetailsExpanded ? "Collapse all" : "Expand all";
      const details = document.querySelectorAll("#turns details.detail-box");
      details.forEach((d) => ((d as HTMLDetailsElement).open = allDetailsExpanded));
    };
  }

  const filterBtns = document.querySelectorAll<HTMLButtonElement>(".turn-filter-btn");
  filterBtns.forEach((btn) => {
    btn.onclick = () => {
      filterBtns.forEach((b) => {
        b.classList.remove("active", "bg-accent", "text-btn-text");
        b.classList.add("text-muted", "border", "border-line");
      });
      btn.classList.add("active", "bg-accent", "text-btn-text");
      btn.classList.remove("text-muted", "border", "border-line");
      currentTurnFilter = (btn.dataset.filter as "all" | "tools" | "errors") || "all";
      if (latestDetail) renderTurns(latestDetail.turns);
    };
  });

  const searchInput = $("turn-search-input") as HTMLInputElement | null;
  if (searchInput) {
    searchInput.oninput = () => {
      currentTurnSearch = searchInput.value;
      if (latestDetail) renderTurns(latestDetail.turns);
    };
  }

  connectStudioEvents("/ws", (event) => {
    if (event.type === "session_changed" && event.sessionId !== sessionId) return;
    if (event.type === "graphs_changed") return;
    void refresh();
  });
}

void init();
