import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsage } from '../../../../shared/context_usage';
import type { GraphNode, Snapshot } from '../../lib/types';

const response = vi.hoisted(() => ({
  data: null as ContextUsage | null,
  loading: true,
  error: '',
}));
vi.mock('./useContextUsage', () => ({
  useContextUsage: () => ({ ...response, refresh: () => {} }),
}));

import { ContextUsagePanel } from './ContextUsagePanel';
import { contextActivity, frozenInputs } from './frozenContextView';

const constraint: GraphNode = {
  id: 'context:maintenance',
  kind: 'constraint',
  label: 'Preserve anonymous access',
  author: 'prior-run:agent-1',
  recorded_at: 1000,
  data: {
    statement:
      'Bug fixes and new features must preserve anonymous calendar access. Never require account creation.',
    purpose: 'Keep the previously approved access requirement while changing calendar code.',
    authority: 'assertion',
    intent_id: 'intent:prior-run',
    links: [{ relation: 'depends_on', target: 'context:calendar-contract' }],
    file_paths: ['public/calendar.mjs'],
  },
};
const contract: GraphNode = {
  ...constraint,
  id: 'context:calendar-contract',
  kind: 'requirement',
  label: 'Calendar contract',
  author: 'owner',
  data: { statement: 'calendarEvents returns stable event IDs.', authority: 'assertion' },
};
const run = {
  id: 'maintenance-run',
  context: [constraint.id, contract.id],
  context_records: [constraint, contract],
};
const snapshot = {
  repository: { id: 'repo' },
  executions: [
    {
      id: 'maintenance-run:agent-1',
      run_id: run.id,
      strategy: 'Calendar fixes',
      context: [constraint.id, contract.id],
    },
  ],
  nodes: [
    {
      ...constraint,
      data: {
        ...constraint.data,
        statement: 'A later statement must not replace the frozen constraint.',
      },
    },
  ],
  edges: [],
  seq: 20,
} as unknown as Snapshot;
const render = (input = run) =>
  renderToStaticMarkup(createElement(ContextUsagePanel, { snapshot, run: input }));
beforeEach(() => {
  response.data = null;
  response.loading = true;
  response.error = '';
});

describe('maintenance context readability', () => {
  it('shows the actual frozen constraint and purpose before retrieval evidence has loaded', () => {
    const html = render();
    expect(html).toContain(constraint.data.statement);
    expect(html).toContain(constraint.data.purpose);
    expect(html).toContain('Assertion');
    expect(html).toContain('prior-run:agent-1');
    expect(html).toContain('depends on');
    expect(html).toContain('public/calendar.mjs');
    expect(html).not.toContain('A later statement must not replace');
  });
  it('retains readable constraints when access evidence fails and never substitutes a current statement for a missing frozen body', () => {
    response.loading = false;
    response.error = 'Retrieval unavailable';
    expect(render()).toContain(constraint.data.statement);
    const html = render({ ...run, context_records: [] });
    expect(html).toContain('Frozen statement unavailable');
    expect(html).not.toContain('A later statement must not replace');
  });
  it('separates assignment, returned search hits, opened records and explicit citations', () => {
    const target = { id: constraint.id };
    const usage = {
      run_id: run.id,
      assigned: [],
      entries: [
        { stage: 'returned', execution_id: 'search-only', targets: [target] },
        { stage: 'opened', execution_id: 'opened-agent', targets: [target] },
      ],
      citations: [{ execution_id: 'citing-agent', targets: [target] }],
    } as unknown as ContextUsage;
    expect(contextActivity(constraint.id, snapshot, run.id, usage)).toEqual({
      assigned: ['maintenance-run:agent-1'],
      opened: ['opened-agent'],
      cited: ['citing-agent'],
      loaded: true,
    });
    const otherRun = contextActivity(constraint.id, snapshot, run.id, {
      ...usage,
      run_id: 'another-run',
    });
    expect(otherRun.opened).toEqual([]);
    expect(otherRun.cited).toEqual([]);
    expect(otherRun.loaded).toBe(false);
  });
  it('does not treat study corpus availability as context assigned to source-only or graph agents', () => {
    const study = { records: [constraint, contract], arm: 'source_only' };
    expect(frozenInputs({ ...run, context_study: study }).ids).toEqual([]);
    expect(frozenInputs({ ...run, context_study: { ...study, arm: 'graph' } }).ids).toEqual([]);
    expect(
      frozenInputs({ ...run, context_study: { ...study, arm: 'plain_notes' } }).records.get(
        constraint.id,
      )?.data.statement,
    ).toBe(constraint.data.statement);
  });
  it('renders supplied context as plain text and does not accept asserted authority as independent checking', () => {
    const unsafe = {
      ...constraint,
      data: { statement: '<script>alert("fake checked")</script>', authority: 'checked_revision' },
    };
    const html = render({ ...run, context_records: [unsafe] });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Assertion');
  });
});
