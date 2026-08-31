// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToSvg, renderSessionSvg } from './render';
import type { SessionDetail } from '../../../studio/types';

describe('bpmn-to-image headless rendering', () => {
  it('renders a workflow diagram headlessly to clean SVG', async () => {
    const xml = readFileSync(resolve(__dirname, '../../../../workflows/pi-default-loop.bpmn'), 'utf-8');
    const svg = await renderToSvg(xml);

    expect(svg).toBeTypeOf('string');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox=');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('llm_turn');
  });

  it('renders a session diagram with visited highlights and activity cost badges', async () => {
    const xml = readFileSync(resolve(__dirname, '../../../../workflows/session-craft.bpmn'), 'utf-8');
    const mockDetail: SessionDetail = {
      id: 'test-session-123',
      project: '/workspace/test',
      status: 'completed',
      updatedAt: Date.now(),
      turnCount: 2,
      graph: xml,
      tokens: [],
      visited: ['session_craft_start', 'craft', 'run_session'],
      revisions: [],
      turns: [
        {
          index: 1,
          activityId: 'craft',
          activityName: 'Craft graph',
          harness: 'graph:craft',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 200,
            cacheWrite: 0,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
          },
        },
      ],
    };

    const svg = await renderSessionSvg(mockDetail, { showCostBadges: true });

    expect(svg).toContain('<svg');
    expect(svg).toContain('ga-visited');
    expect(svg).toContain('$0.0031');
  });

  it('renders session-default.bpmn and shell-demo.bpmn', async () => {
    const defaultXml = readFileSync(resolve(__dirname, '../../../../workflows/session-default.bpmn'), 'utf-8');
    const defaultSvg = await renderToSvg(defaultXml);
    expect(defaultSvg).toContain('<svg');
    expect(defaultSvg).toContain('agent_loop');

    const shellXml = readFileSync(resolve(__dirname, '../../../../workflows/shell-demo.bpmn'), 'utf-8');
    const shellSvg = await renderToSvg(shellXml);
    expect(shellSvg).toContain('<svg');
    expect(shellSvg).toContain('turn');
  });
});
