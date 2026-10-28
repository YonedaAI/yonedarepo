import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { RunControls } from './RunControls';
import { runDeleteBlocker } from './runControlState';

const snapshot = (overrides: Partial<Snapshot> = {}) =>
  ({
    repository: { id: 'repo', pending: null },
    runs: [],
    executions: [],
    candidates: [],
    evaluations: [],
    decisions: [],
    artifacts: [],
    ...overrides,
  }) as unknown as Snapshot;
const noop = () => {};
const controls = (run: Record<string, any>, deleteBlocker?: string, reviewer = false) =>
  renderToStaticMarkup(
    createElement(RunControls, {
      reviewer,
      run,
      busy: false,
      canStart: true,
      activeAttempts: false,
      hasRoots: true,
      supportsRestart: true,
      onRestart: noop,
      onCancel: noop,
      deleteBlocker,
      onDelete: noop,
    }),
  );
const deleteButton = (html: string) =>
  html.match(/<button[^>]*>(?:(?!<\/button>).)*Delete run/)?.[0];

describe('run deletion control', () => {
  it('blocks deletion while the run or one of its attempts is active', () => {
    const run = { id: 'run', status: 'ready' };
    expect(runDeleteBlocker(snapshot(), { id: 'run', status: 'exploring' })).toBe(
      'Cancel the run before deleting it.',
    );
    const building = snapshot({ executions: [{ id: 'e', run_id: 'run', status: 'running' }] });
    expect(runDeleteBlocker(building, run)).toBe('Cancel the run before deleting it.');
    for (const status of ['accepted', 'cancelled', 'failed', 'ready'])
      expect(runDeleteBlocker(snapshot(), { ...run, status })).toBeUndefined();
  });
  it('blocks deletion while this run’s publication is pending', () => {
    const publishing = snapshot({
      repository: { id: 'repo', pending: 'decision' } as Snapshot['repository'],
      decisions: [{ id: 'decision', run_id: 'run' }],
    });
    expect(runDeleteBlocker(publishing, { id: 'run', status: 'accepted' })).toContain(
      'publication',
    );
    expect(runDeleteBlocker(publishing, { id: 'other', status: 'accepted' })).toBeUndefined();
  });
  it('shows the control disabled with its reason, enabled once settled, and never to reviewers', () => {
    const blocked = controls({ status: 'exploring' }, 'Cancel the run before deleting it.');
    expect(deleteButton(blocked)).toContain('disabled');
    expect(blocked).toContain('Cancel the run before deleting it.');
    const settled = controls({ status: 'cancelled' });
    expect(deleteButton(settled)).toBeDefined();
    expect(deleteButton(settled)).not.toContain('disabled');
    expect(controls({ status: 'cancelled' }, undefined, true)).not.toContain('Delete run');
  });
});
