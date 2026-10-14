import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { AgentWorkSummary } from './AgentWorkSummary';

const timedOutCoordinator = {
  id: 'coordinator:1',
  run_id: 'run',
  role: 'coding',
  team_role: 'coordinator',
  strategy: 'Coordinate approved team recovery',
  status: 'failed',
  started_at: 1,
  error: 'EXECUTION_TIMEOUT: Execution deadline exceeded',
};

function render(run: Record<string, unknown>, executions: Record<string, unknown>[]) {
  const snapshot = { executions, team_tasks: [], runs: [run] } as unknown as Snapshot;
  return renderToStaticMarkup(
    createElement(AgentWorkSummary, { snapshot, run, onInspect: () => {} }),
  );
}

describe('agent work summary', () => {
  it('shows a timed-out attempt as superseded once the run settled', () => {
    const html = render({ id: 'run', status: 'ready' }, [timedOutCoordinator]);
    expect(html).toContain('Superseded');
    expect(html).toContain('later work completed');
    expect(html).not.toContain('Blocked');
  });

  it('shows a timed-out attempt as superseded when a later attempt of the same role exists', () => {
    const retry = { ...timedOutCoordinator, id: 'coordinator:2', status: 'running', started_at: 2 };
    const html = render({ id: 'run', status: 'coordinating' }, [timedOutCoordinator, retry]);
    expect(html).toContain('Superseded');
    expect(html).toContain('Working');
  });

  it('still reports a failure as blocked while nothing replaced it', () => {
    const html = render({ id: 'run', status: 'coordinating' }, [timedOutCoordinator]);
    expect(html).toContain('Blocked');
  });
});
