import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { AgentWorkSummary } from './AgentWorkSummary';

const timedOutAttempt = {
  id: 'run:agent-1',
  run_id: 'run',
  role: 'coding',
  strategy: 'Fix the registration bug',
  status: 'failed',
  started_at: 1,
  error: 'EXECUTION_TIMEOUT: Execution deadline exceeded',
};

function render(run: Record<string, unknown>, executions: Record<string, unknown>[]) {
  const snapshot = { executions, runs: [run] } as unknown as Snapshot;
  return renderToStaticMarkup(
    createElement(AgentWorkSummary, { snapshot, run, onInspect: () => {} }),
  );
}

describe('agent work summary', () => {
  it('shows a timed-out attempt as superseded once the run settled', () => {
    const html = render({ id: 'run', status: 'ready' }, [timedOutAttempt]);
    expect(html).toContain('Superseded');
    expect(html).toContain('later work completed');
    expect(html).not.toContain('Blocked');
  });

  it('shows a timed-out attempt as superseded when a later attempt exists', () => {
    const retry = { ...timedOutAttempt, id: 'run:agent-2', status: 'running', started_at: 2 };
    const html = render({ id: 'run', status: 'exploring' }, [timedOutAttempt, retry]);
    expect(html).toContain('Superseded');
    expect(html).toContain('Working');
  });

  it('still reports a failure as blocked while nothing replaced it', () => {
    const html = render({ id: 'run', status: 'exploring' }, [timedOutAttempt]);
    expect(html).toContain('Blocked');
  });
});
