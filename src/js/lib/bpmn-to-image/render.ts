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
 * called subprocesses like pi_default_loop) with visited markers and cost badges.
 */
export async function renderSessionDiagrams(
  detail: SessionDetail,
  options: RenderToPngOptions & { showCostBadges?: boolean; includePngDataUri?: boolean } = {}
): Promise<RenderedSessionDiagram[]> {
  const modeler = await createModelerFromXml(detail.graph, options);
  const defs = modeler.getDefinitions();
  const diagrams = defs?.diagrams || [];

  const activityCosts = new Map<string, { cost: number; turns: number; durationMs: number }>();
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
    }
  }

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
    for (const id of detail.visited || []) {
      if (elementRegistry.get(id)) {
        try {
          canvas.addMarker(id, 'ga-visited');
        } catch {}
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

    if (options.showCostBadges !== false && svg) {
      const badges: string[] = [];
      const allElements = elementRegistry.getAll();

      for (const shape of allElements) {
        if (!shape || typeof shape.x !== 'number' || typeof shape.y !== 'number' || !shape.width) continue;

        let cost = 0;
        let turns = 0;

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

        if (cost > 0 || turns > 0) {
          const costFormatted = cost > 0
            ? (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`)
            : `${turns} turn${turns === 1 ? '' : 's'}`;
          const badgeWidth = Math.max(46, costFormatted.length * 6.5 + 8);
          const bx = shape.x + shape.width - badgeWidth;
          const by = shape.y + shape.height - 14;
          badges.push(
            `<g class="ga-cost-badge" transform="translate(${bx}, ${by})">` +
            `<rect x="0" y="0" width="${badgeWidth}" height="14" rx="3" fill="#0f766e" fill-opacity="0.95"/>` +
            `<text x="${badgeWidth / 2}" y="10" fill="#ffffff" font-family="monospace" font-size="9" text-anchor="middle" font-weight="bold">${costFormatted}</text>` +
            `</g>`
          );
        }
      }

      if (badges.length > 0) {
        svg = svg.replace('</svg>', `${badges.join('')}</svg>`);
      }
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
