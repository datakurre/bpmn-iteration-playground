import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SessionDetail, TurnRecord } from "../studio/types.ts";
import { renderSessionSvg, renderToSvg } from "../js/lib/bpmn-to-image/render.ts";
import { SessionStore } from "../agent/session-store.ts";
import { requirePaths } from "./main.ts";

export interface ActivitySummary {
  activityId: string;
  activityName: string;
  harness: string;
  turns: number;
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
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
      durationMs: 0,
    };
    existing.turns += 1;
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

export async function generateMarkdownReport(
  detail: SessionDetail,
  options: { embedSvg?: boolean } = {}
): Promise<string> {
  const stats = detail.stats;
  const activities = computeActivitySummaries(detail.turns);
  const totalCost = stats?.totalCostUSD ? formatCost(stats.totalCostUSD) : "$0.00";
  const totalTokens = stats?.totalTokens ? formatTokens(stats.totalTokens) : "0";
  const cacheHit = stats?.cacheHitRatio !== undefined ? `${Math.round(stats.cacheHitRatio * 100)}%` : "0%";

  let svgSection = "";
  if (options.embedSvg) {
    try {
      const svg = await renderSessionSvg(detail, { showCostBadges: true, background: "#ffffff" });
      svgSection = `\n## Execution Diagram\n\n\`\`\`xml\n${svg}\n\`\`\`\n`;
    } catch {
      // Best effort
    }
  }

  let activityTable = "| Activity | Harness | Turns | In / Out / Cache | Reasoning | Cost ($ USD) | Duration |\n";
  activityTable += "| :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n";
  for (const act of activities) {
    const tokens = `${formatTokens(act.inputTokens)} / ${formatTokens(act.outputTokens)} / ${formatTokens(act.cacheReadTokens)}`;
    const dur = act.durationMs > 0 ? `${(act.durationMs / 1000).toFixed(1)}s` : "-";
    activityTable += `| \`${act.activityId}\` | \`${act.harness}\` | ${act.turns} | ${tokens} | ${formatTokens(act.reasoningTokens)} | ${formatCost(act.costUSD)} | ${dur} |\n`;
  }

  let turnLog = "| # | Activity | Harness | Stop Reason | Tools | Tokens (In/Out/Cache) | Cost ($ USD) |\n";
  turnLog += "| :---: | :--- | :--- | :---: | :--- | :---: | :---: |\n";
  for (const turn of detail.turns) {
    const tools = turn.toolCalls?.length ? turn.toolCalls.join(", ") : "-";
    const tokens = turn.usage ? `${turn.usage.input}/${turn.usage.output}/${turn.usage.cacheRead}` : "-";
    const cost = turn.usage?.cost?.total ? formatCost(turn.usage.cost.total) : "-";
    turnLog += `| ${turn.index} | \`${turn.activityId}\` | \`${turn.harness ?? "-"}\` | ${turn.stopReason ?? "-"} | ${tools} | ${tokens} | ${cost} |\n`;
  }

  let revisionsLog = "";
  if (detail.revisions.length > 0) {
    revisionsLog = "\n## Graph Revisions\n\n";
    for (const rev of detail.revisions) {
      const added = rev.addedElementIds.length ? ` (+${rev.addedElementIds.join(", ")})` : "";
      revisionsLog += `- **r${rev.index}** (${new Date(rev.at).toLocaleTimeString()}): ${rev.reason}${added}\n`;
    }
  }

  return `# Session Report: ${detail.name || detail.id}

- **Session ID**: \`${detail.id}\`
- **Status**: \`${detail.status}\`
- **Total Cost**: **${totalCost}**
- **Turns**: ${detail.turnCount}
- **Total Tokens**: ${totalTokens} (${cacheHit} cache hit)
- **Project**: \`${detail.project}\`
${svgSection}
## Activity Breakdown

${activityTable}
## Chronological Turn Log

${turnLog}${revisionsLog}
`;
}

export async function generateHtmlReport(detail: SessionDetail): Promise<string> {
  const md = await generateMarkdownReport(detail, { embedSvg: false });
  const svg = await renderSessionSvg(detail, { showCostBadges: true, background: "#ffffff" });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session Report - ${detail.id}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #fafafa; color: #1e293b; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .metrics { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .metric-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 1rem 1.5rem; min-width: 140px; }
    .metric-val { font-size: 1.5rem; font-weight: bold; color: #0f766e; }
    .metric-lbl { font-size: 0.75rem; text-transform: uppercase; color: #64748b; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.875rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; color: #475569; }
    .diagram-container { overflow-x: auto; background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; text-align: center; }
  </style>
</head>
<body>
  <h1>Session Report: ${detail.id}</h1>
  <div class="metrics">
    <div class="metric-box"><div class="metric-val">${detail.status}</div><div class="metric-lbl">Status</div></div>
    <div class="metric-box"><div class="metric-val">${formatCost(detail.stats?.totalCostUSD || 0)}</div><div class="metric-lbl">Total Cost</div></div>
    <div class="metric-box"><div class="metric-val">${detail.turnCount}</div><div class="metric-lbl">Turns</div></div>
    <div class="metric-box"><div class="metric-val">${formatTokens(detail.stats?.totalTokens || 0)}</div><div class="metric-lbl">Tokens</div></div>
    <div class="metric-box"><div class="metric-val">${Math.round((detail.stats?.cacheHitRatio || 0) * 100)}%</div><div class="metric-lbl">Cache Hit</div></div>
  </div>

  <div class="card">
    <h2>Execution Diagram</h2>
    <div class="diagram-container">
      ${svg}
    </div>
  </div>

  <div class="card">
    <h2>Activity Breakdown</h2>
    <table>
      <thead>
        <tr><th>Activity</th><th>Harness</th><th>Turns</th><th>Tokens (In/Out/Cache)</th><th>Reasoning</th><th>Cost ($ USD)</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${computeActivitySummaries(detail.turns).map(a => `
          <tr>
            <td><code>${a.activityId}</code></td>
            <td><code>${a.harness}</code></td>
            <td>${a.turns}</td>
            <td>${formatTokens(a.inputTokens)} / ${formatTokens(a.outputTokens)} / ${formatTokens(a.cacheReadTokens)}</td>
            <td>${formatTokens(a.reasoningTokens)}</td>
            <td>${formatCost(a.costUSD)}</td>
            <td>${a.durationMs > 0 ? (a.durationMs / 1000).toFixed(1) + "s" : "-"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export async function cmdReport(
  id: string | undefined,
  flags: { format?: string; out?: string; embedSvg?: boolean }
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
    output = await generateHtmlReport(detail);
  } else {
    output = await generateMarkdownReport(detail, { embedSvg: flags.embedSvg });
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
  flags: { out?: string; background?: string }
): Promise<number> {
  if (!target) {
    process.stderr.write("graph-agent: export requires a session id or .bpmn file path\n");
    return 2;
  }

  let svg = "";
  const p = requirePaths();
  if (p && new SessionStore(p, target).exists()) {
    const detail = new SessionStore(p, target).detail();
    svg = await renderSessionSvg(detail, { showCostBadges: true, background: flags.background });
  } else {
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(target)) {
      process.stderr.write(`graph-agent: cannot find session or file '${target}'\n`);
      return 1;
    }
    const xml = readFileSync(target, "utf-8");
    svg = await renderToSvg(xml, { background: flags.background });
  }

  if (flags.out) {
    const targetPath = resolve(flags.out);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, svg);
    process.stdout.write(`exported diagram to ${flags.out}\n`);
  } else {
    process.stdout.write(svg);
  }
  return 0;
}
