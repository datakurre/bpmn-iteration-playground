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

/**
 * Render a session's execution diagram to SVG with visited path highlights,
 * active token markers, and activity cost / duration overlays.
 */
export async function renderSessionSvg(
  detail: SessionDetail,
  options: RenderOptions & { showCostBadges?: boolean } = {}
): Promise<string> {
  const modeler = await createModelerFromXml(detail.graph, options);
  const canvas = modeler.get('canvas');
  const overlays = modeler.get('overlays');

  // Mark visited elements
  for (const id of detail.visited || []) {
    try {
      canvas.addMarker(id, 'ga-visited');
    } catch {}
  }

  // Mark active tokens
  for (const id of detail.tokens || []) {
    try {
      canvas.addMarker(id, 'ga-token');
    } catch {}
  }

  // Add floating cost badges
  if (options.showCostBadges !== false && detail.turns?.length) {
    const activityCosts = new Map<string, { cost: number; turns: number; durationMs: number }>();
    for (const turn of detail.turns) {
      const prev = activityCosts.get(turn.activityId) || { cost: 0, turns: 0, durationMs: 0 };
      prev.cost += turn.usage?.cost?.total ?? 0;
      prev.turns += 1;
      if (turn.startedAt && turn.endedAt) prev.durationMs += (turn.endedAt - turn.startedAt);
      activityCosts.set(turn.activityId, prev);
    }
    for (const [activityId, stat] of activityCosts) {
      if (stat.cost > 0 || stat.turns > 0) {
        try {
          const costFormatted = stat.cost > 0
            ? (stat.cost < 0.01 ? `$${stat.cost.toFixed(4)}` : `$${stat.cost.toFixed(2)}`)
            : `${stat.turns}t`;
          overlays.add(activityId, 'cost-badge', {
            position: { bottom: 0, right: 0 },
            html: `<div style="background:#0f766e;color:white;font-size:9px;font-family:monospace;padding:1px 4px;border-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,0.2);">${costFormatted}</div>`,
          });
        } catch {}
      }
    }
  }

  let { svg } = await modeler.saveSVG();
  const elementRegistry = modeler.get('elementRegistry');

  if (options.showCostBadges !== false && detail.turns?.length && svg) {
    const activityCosts = new Map<string, { cost: number; turns: number; durationMs: number }>();
    for (const turn of detail.turns) {
      const prev = activityCosts.get(turn.activityId) || { cost: 0, turns: 0, durationMs: 0 };
      prev.cost += turn.usage?.cost?.total ?? 0;
      prev.turns += 1;
      if (turn.startedAt && turn.endedAt) prev.durationMs += (turn.endedAt - turn.startedAt);
      activityCosts.set(turn.activityId, prev);
    }

    const badges: string[] = [];
    for (const [activityId, stat] of activityCosts) {
      const shape = elementRegistry.get(activityId);
      if (shape && typeof shape.x === 'number' && typeof shape.y === 'number') {
        const costFormatted = stat.cost > 0
          ? (stat.cost < 0.01 ? `$${stat.cost.toFixed(4)}` : `$${stat.cost.toFixed(2)}`)
          : `${stat.turns} turn${stat.turns === 1 ? '' : 's'}`;
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

  return tightenSvgViewBox(svg || '', elementRegistry.getAll(), undefined, options.background);
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
