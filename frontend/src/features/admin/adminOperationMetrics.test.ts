import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { OperationReport } from '../../../../shared/operation-metrics';
import { OperationMetricsView } from './AdminOperationMetrics';

const report: OperationReport = {
  rows: [],
  window: { start: 0, end: 1 },
  coverage: { enabled: true, fullUntil: null, detailEvery: 10, sampled: true },
  status: 'ok',
};
const render = (value: OperationReport) =>
  renderToStaticMarkup(createElement(OperationMetricsView, { report: value }));
it('does not invent observations in an empty or unavailable window', () => {
  expect(render(report)).toContain('No operations measured');
  expect(render(report)).not.toContain('<table');
  expect(render({ ...report, status: 'unavailable' })).toContain('unavailable');
});
it('labels cohorts and estimates while missing latency stays unknown', () => {
  const page = render({
    ...report,
    rows: [
      {
        kind: 'repository',
        operation: 'repo_commit',
        source: 'mcp',
        traffic: 'marked_automation',
        actor: 'token',
        outcome: 'refused',
        requests: 10,
        p50: null,
        p95: 20,
        p99: null,
        queueWaitP95: null,
        estimated: true,
      },
    ],
  });
  expect(page).toContain('MCP');
  expect(page).toContain('Our tools');
  expect(page).toContain('refused');
  expect(page).toContain('≈10');
  expect(page).toContain('—');
  expect(page).not.toContain('SLO');
});

it('makes measurements discoverable without enabling unconfigured operations reports', async () => {
  const { shownSections } = await import('./adminModel');
  const tabs = shownSections({
    operations: false,
    measurements: true,
    visitors: false,
    agents: false,
  });
  expect(tabs).toContain('infrastructure');
  expect(tabs).not.toContain('operations');
});
