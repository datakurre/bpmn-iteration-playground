/**
 * Public rendering API: BPMN 2.0 XML → SVG / PNG.
 */

import { createModelerFromXml, type CreateModelerOptions } from './modeler.ts';
import { svgToPng, tightenSvgViewBox } from './svg-to-png.ts';

export interface RenderOptions extends CreateModelerOptions {
  /** Background color (CSS color string, e.g. "white", "#FFFFFF"). Default: undefined (transparent). */
  background?: string;
}

export interface RenderToPngOptions extends RenderOptions {
  /** Pixel density multiplier passed to the SVG→PNG rasterizer. Default: 2. */
  scale?: number;
}

import type { SessionDetail } from '../../../studio/types.ts';

/**
 * Render BPMN 2.0 XML to an SVG string.
 *
 * Imports the XML into a headless bpmn-js modeler and exports it via
 * `saveSVG()`, tightening the viewBox to the diagram's actual content
 * bounds (shapes, labels, and connection waypoints).
 */
export async function renderToSvg(xml: string, options: RenderOptions = {}): Promise<string> {
  const modeler = await createModelerFromXml(xml, options);
  const { svg } = await modeler.saveSVG();
  const elementRegistry = modeler.get('elementRegistry');
  return tightenSvgViewBox(svg || '', elementRegistry.getAll(), undefined, options.background);
}

export function formatTurnRange(indices: number[]): string {
  if (!indices || indices.length === 0) return "";
  if (indices.length === 1) return `T${indices[0]}`;
  const sorted = [...indices].sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  if (max - min + 1 === sorted.length) {
    return `T${min}..T${max}`;
  }
  if (sorted.length <= 3) {
    return sorted.map((i) => `T${i}`).join(",");
  }
  return `T${min}..T${max} (${sorted.length}t)`;
}

export interface RenderedSessionDiagram {
  id?: string;
  processId: string;
  name: string;
  isRoot: boolean;
  svg: string;
  pngDataUri?: string;
  turnCount: number;
  totalCostUSD: number;
}

/**
 * Render all diagrams defined in a session's BPMN definitions (both root workflow and
 * called subprocesses like pi_default_loop) with visited markers, sequence flow highlights,
 * turn badges, and cost badges.
 */
export async function renderSessionDiagrams(
  detail: SessionDetail,
  options: RenderToPngOptions & { showCostBadges?: boolean; includePngDataUri?: boolean } = {}
): Promise<RenderedSessionDiagram[]> {
  const modeler = await createModelerFromXml(detail.graph, options);
  const defs = modeler.getDefinitions();
  const diagrams = defs?.diagrams || [];

  const activityCosts = new Map<string, { cost: number; turns: number; durationMs: number }>();
  const activityTurns = new Map<string, number[]>();
  let totalSessionTurns = 0;
  let totalSessionCost = 0;
  if (detail.turns?.length) {
    for (const turn of detail.turns) {
      const prev = activityCosts.get(turn.activityId) || { cost: 0, turns: 0, durationMs: 0 };
      const turnCost = turn.usage?.cost?.total ?? 0;
      prev.cost += turnCost;
      prev.turns += 1;
      totalSessionTurns += 1;
      totalSessionCost += turnCost;
      if (turn.startedAt && turn.endedAt) prev.durationMs += turn.endedAt - turn.startedAt;
      activityCosts.set(turn.activityId, prev);

      const tList = activityTurns.get(turn.activityId) || [];
      tList.push(turn.index);
      activityTurns.set(turn.activityId, tList);
    }
  }

  const visitedSet = new Set(detail.visited || []);
  const results: RenderedSessionDiagram[] = [];
  const diagramList = diagrams.length > 0 ? diagrams : [undefined];

  for (let i = 0; i < diagramList.length; i++) {
    const d = diagramList[i];
    if (d) {
      try {
        await modeler.open(d);
      } catch {
        continue;
      }
    }

    const canvas = modeler.get('canvas');
    const elementRegistry = modeler.get('elementRegistry');
    const processId = d?.plane?.bpmnElement?.id || '';
    const name = d?.plane?.bpmnElement?.name || processId || (i === 0 ? 'Main Process' : `Diagram ${i + 1}`);
    const isRoot = d ? (d.plane?.bpmnElement?.isExecutable === true || i === 0) : true;

    // Mark visited elements present in this diagram
    for (const id of visitedSet) {
      if (elementRegistry.get(id)) {
        try {
          canvas.addMarker(id, 'ga-visited');
        } catch {}
      }
    }

    // Mark failed/errored elements present in this diagram
    const failedActivityIds = new Set(
      (detail.turns || [])
        .filter((t) => t.stopReason === 'error' || t.error)
        .map((t) => t.activityId)
    );
    for (const id of failedActivityIds) {
      if (elementRegistry.get(id)) {
        try {
          canvas.addMarker(id, 'ga-error');
        } catch {}
      }
    }

    // Also mark visited sequence flows if both source and target were visited
    const allElements = elementRegistry.getAll();
    for (const shape of allElements) {
      if (shape && shape.type === 'bpmn:SequenceFlow') {
        const sourceId = shape.source?.id;
        const targetId = shape.target?.id;
        if (sourceId && targetId && visitedSet.has(sourceId) && visitedSet.has(targetId)) {
          try {
            canvas.addMarker(shape.id, 'ga-visited');
          } catch {}
        }
      } else if (shape && (shape.type === 'bpmn:Lane' || shape.type === 'bpmn:Participant')) {
        const children = shape.children || [];
        if (children.some((c: any) => visitedSet.has(c.id))) {
          try {
            canvas.addMarker(shape.id, 'ga-visited-lane');
          } catch {}
        }
      }
    }

    // Mark active tokens present in this diagram
    for (const id of detail.tokens || []) {
      if (elementRegistry.get(id)) {
        try {
          canvas.addMarker(id, 'ga-token');
        } catch {}
      }
    }

    let { svg } = await modeler.saveSVG();
    let diagramTurns = 0;
    let diagramCost = 0;

    if (svg) {
      // Direct SVG attribute replacement so resvg / rasterizers & all browsers render highlights reliably
      svg = svg.replace(/<g class="([^"]*\bga-(visited|error|token|visited-lane)\b[^"]*)"([^>]*)>([\s\S]*?)<\/g>/g, (_match: string, classAttr: string, _markerType: string, restAttrs: string, innerContent: string) => {
        let stroke = '#059669';
        let fill = '#ecfdf5';
        let strokeWidth = '2.5px';

        if (classAttr.includes('ga-error')) {
          stroke = '#dc2626';
          fill = '#fef2f2';
          strokeWidth = '3px';
        } else if (classAttr.includes('ga-token')) {
          stroke = '#d97706';
          fill = '#fef3c7';
          strokeWidth = '3.5px';
        } else if (classAttr.includes('ga-visited-lane')) {
          stroke = '#059669';
          fill = 'none';
          strokeWidth = '2px';
        }

        const isConnection = classAttr.includes('djs-connection');

        let updatedInner = innerContent;
        if (isConnection) {
          updatedInner = updatedInner.replace(/<path([^>]*?)(\/?>)/g, (_m: string, p1: string, p2: string) => {
            let p = p1.replace(/\s*style="[^"]*"/g, '').replace(/\s*stroke="[^"]*"/g, '').replace(/\s*fill="[^"]*"/g, '').replace(/\s*stroke-width="[^"]*"/g, '');
            return `<path${p} stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" style="stroke: ${stroke} !important; stroke-width: ${strokeWidth} !important; fill: none !important;"${p2}`;
          });
          updatedInner = updatedInner.replace(/<(polygon|polyline)([^>]*?)(\/?>)/g, (_m: string, tag: string, p1: string, p2: string) => {
            let p = p1.replace(/\s*style="[^"]*"/g, '').replace(/\s*stroke="[^"]*"/g, '').replace(/\s*fill="[^"]*"/g, '').replace(/\s*stroke-width="[^"]*"/g, '');
            return `<${tag}${p} stroke="${stroke}" stroke-width="${strokeWidth}" fill="${stroke}" style="stroke: ${stroke} !important; stroke-width: ${strokeWidth} !important; fill: ${stroke} !important;"${p2}`;
          });
        } else {
          updatedInner = updatedInner.replace(/<(rect|circle|polygon)([^>]*?)(\/?>)/g, (_m: string, tag: string, p1: string, p2: string) => {
            let p = p1.replace(/\s*style="[^"]*"/g, '').replace(/\s*stroke="[^"]*"/g, '').replace(/\s*fill="[^"]*"/g, '').replace(/\s*stroke-width="[^"]*"/g, '');
            if (classAttr.includes('ga-visited-lane')) {
              return `<${tag}${p} stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="6 3" fill="none" style="stroke: ${stroke} !important; stroke-width: ${strokeWidth} !important; stroke-dasharray: 6 3 !important; fill: none !important;"${p2}`;
            }
            return `<${tag}${p} stroke="${stroke}" stroke-width="${strokeWidth}" fill="${fill}" style="stroke: ${stroke} !important; fill: ${fill} !important; stroke-width: ${strokeWidth} !important;"${p2}`;
          });
          updatedInner = updatedInner.replace(/<path([^>]*?)(\/?>)/g, (_m: string, p1: string, p2: string) => {
            let p = p1.replace(/\s*style="[^"]*"/g, '').replace(/\s*stroke="[^"]*"/g, '').replace(/\s*fill="[^"]*"/g, '');
            return `<path${p} stroke="${stroke}" fill="none" style="stroke: ${stroke} !important; fill: none !important;"${p2}`;
          });
        }

        return `<g class="${classAttr}"${restAttrs}>${updatedInner}</g>`;
      });

      const injectedStyles = `
        <style>
          .ga-visited.djs-shape .djs-visual rect,
          .ga-visited.djs-shape .djs-visual circle,
          .ga-visited.djs-shape .djs-visual polygon {
            stroke: #059669 !important;
            stroke-width: 2.5px !important;
            fill: #ecfdf5 !important;
          }
          .ga-visited.djs-connection .djs-visual path {
            stroke: #059669 !important;
            stroke-width: 2.5px !important;
          }
          .ga-error.djs-shape .djs-visual rect,
          .ga-error.djs-shape .djs-visual circle {
            stroke: #dc2626 !important;
            stroke-width: 3px !important;
            fill: #fef2f2 !important;
          }
          .ga-token.djs-shape .djs-visual rect,
          .ga-token.djs-shape .djs-visual circle {
            stroke: #d97706 !important;
            stroke-width: 3.5px !important;
            fill: #fef3c7 !important;
          }
          .ga-cost-badge rect, .ga-turn-badge rect {
            rx: 2px;
          }
          .ga-cost-badge text, .ga-turn-badge text {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          }
        </style>
      `;

      const badges: string[] = [];

      if (options.showCostBadges !== false) {
        for (const shape of allElements) {
          if (!shape || typeof shape.x !== 'number' || typeof shape.y !== 'number' || !shape.width) continue;

          let cost = 0;
          let turns = 0;
          const turnList = activityTurns.get(shape.id);

          if (activityCosts.has(shape.id)) {
            const stat = activityCosts.get(shape.id)!;
            cost = stat.cost;
            turns = stat.turns;
            diagramCost += cost;
            diagramTurns += turns;
          } else if (shape.type === 'bpmn:CallActivity' || shape.businessObject?.$type === 'bpmn:CallActivity') {
            // Aggregate subprocess costs onto callActivity node if root
            const calledElement = shape.businessObject?.calledElement;
            if (calledElement && totalSessionTurns > 0) {
              cost = totalSessionCost;
              turns = totalSessionTurns;
            }
          }

          // 1. Turn Symbol badge on top-left of activity (e.g. [T1..T11])
          if (turnList && turnList.length > 0) {
            const turnRangeStr = formatTurnRange(turnList);
            const tWidth = Math.max(28, turnRangeStr.length * 6.5 + 8);
            const tx = shape.x;
            const ty = Math.max(0, shape.y - 12);
            badges.push(
              `<g class="ga-turn-badge" transform="translate(${tx}, ${ty})">` +
              `<rect x="0" y="0" width="${tWidth}" height="14" rx="2" fill="#4338ca" fill-opacity="0.95"/>` +
              `<text x="${tWidth / 2}" y="10" fill="#ffffff" font-family="monospace" font-size="9" text-anchor="middle" font-weight="bold">${turnRangeStr}</text>` +
              `</g>`
            );
          }

          // 2. Cost badge on bottom-right of activity (e.g. $0.0051)
          if (cost > 0 || turns > 0) {
            const costFormatted = cost > 0
              ? (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`)
              : `${turns} turn${turns === 1 ? '' : 's'}`;
            const badgeWidth = Math.max(46, costFormatted.length * 6.5 + 8);
            const bx = shape.x + shape.width - badgeWidth;
            const by = shape.y + shape.height - 14;
            badges.push(
              `<g class="ga-cost-badge" transform="translate(${bx}, ${by})">` +
              `<rect x="0" y="0" width="${badgeWidth}" height="14" rx="2" fill="#0f766e" fill-opacity="0.95"/>` +
              `<text x="${badgeWidth / 2}" y="10" fill="#ffffff" font-family="monospace" font-size="9" text-anchor="middle" font-weight="bold">${costFormatted}</text>` +
              `</g>`
            );
          }
        }
      }

      svg = svg.replace('</svg>', `${injectedStyles}${badges.join('')}</svg>`);
    }

    const tightenedSvg = tightenSvgViewBox(svg || '', elementRegistry.getAll(), undefined, options.background);
    let pngDataUri: string | undefined;
    if (options.includePngDataUri) {
      try {
        const pngBuf = svgToPng(tightenedSvg, { scale: options.scale ?? 2, background: options.background ?? '#ffffff' });
        pngDataUri = `data:image/png;base64,${pngBuf.toString('base64')}`;
      } catch {}
    }

    results.push({
      id: d?.id,
      processId,
      name,
      isRoot,
      svg: tightenedSvg,
      pngDataUri,
      turnCount: diagramTurns,
      totalCostUSD: diagramCost,
    });
  }

  return results;
}

/**
 * Render a session's execution diagram to SVG with visited path highlights,
 * active token markers, and activity cost / duration overlays.
 */
export async function renderSessionSvg(
  detail: SessionDetail,
  options: RenderOptions & { showCostBadges?: boolean } = {}
): Promise<string> {
  const diagrams = await renderSessionDiagrams(detail, options);
  if (diagrams.length === 0) return '';
  // Pick the diagram with active turns if available, else the root diagram
  const active = diagrams.find((d) => d.turnCount > 0) || diagrams.find((d) => d.isRoot) || diagrams[0];
  return active?.svg ?? '';
}

/**
 * Render BPMN 2.0 XML to a PNG buffer.
 *
 * Equivalent to `renderToSvg` followed by `svgToPng`.
 */
export async function renderToPng(xml: string, options: RenderToPngOptions = {}): Promise<Buffer> {
  const svg = await renderToSvg(xml, options);
  return svgToPng(svg, { scale: options.scale, background: options.background });
}

/**
 * Render a session's execution diagram to a PNG buffer with highlights and cost badges.
 */
export async function renderSessionPng(
  detail: SessionDetail,
  options: RenderToPngOptions & { showCostBadges?: boolean } = {}
): Promise<Buffer> {
  const svg = await renderSessionSvg(detail, options);
  return svgToPng(svg, { scale: options.scale ?? 2, background: options.background });
}

/**
 * Render BPMN XML to a base64 PNG data URI (`data:image/png;base64,...`).
 */
export async function renderToPngDataUri(xml: string, options: RenderToPngOptions = {}): Promise<string> {
  const png = await renderToPng(xml, options);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Render a session execution diagram to a base64 PNG data URI (`data:image/png;base64,...`).
 */
export async function renderSessionPngDataUri(
  detail: SessionDetail,
  options: RenderToPngOptions & { showCostBadges?: boolean } = {}
): Promise<string> {
  const png = await renderSessionPng(detail, options);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Render BPMN XML to a base64 SVG data URI (`data:image/svg+xml;base64,...`).
 */
export async function renderToSvgDataUri(xml: string, options: RenderOptions = {}): Promise<string> {
  const svg = await renderToSvg(xml, options);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Render a session execution diagram to a base64 SVG data URI (`data:image/svg+xml;base64,...`).
 */
export async function renderSessionSvgDataUri(
  detail: SessionDetail,
  options: RenderOptions & { showCostBadges?: boolean } = {}
): Promise<string> {
  const svg = await renderSessionSvg(detail, options);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
