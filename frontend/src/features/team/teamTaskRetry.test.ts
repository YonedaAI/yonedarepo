import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Call the card as a function to reach its button handler without a DOM.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [initial, () => {}],
}));

import { providerFailureNotice } from '../exploration/providerFailure';
import { TeamTaskCard } from './TeamTaskCard';
import { retryBlocker } from './teamView';

function find(element: ReactNode, label: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, label)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  if (item.type === 'button' && item.props.children === label) return item;
  // Expand only the hook-free retry control; other children are rendered as HTML below.
  if (typeof item.type === 'function' && item.type.name === 'TeamRetry')
    return find((item.type as (props: unknown) => ReactNode)(item.props), label);
  return find(item.props.children, label);
}

// The laundry run: attempt 4 of the site task timed out; its dependent tests task never started.
const site = {
  id: 'run-1:task:site',
  task_id: 'site',
  run_id: 'run-1',
  title: 'Build Chicago laundry pickup order site (public/)',
  status: 'failed',
  revision: 3,
  epoch: 4,
  agent: 0,
  role: 'worker',
  execution_id: 'run-1:task:site',
  error: 'EXECUTION_TIMEOUT: Execution deadline exceeded',
};
const tests = {
  id: 'run-1:task:tests',
  task_id: 'tests',
  run_id: 'run-1',
  title: 'Add Node tests for order logic (tests/)',
  status: 'blocked',
  revision: 1,
  epoch: 0,
  agent: 0,
  role: 'worker',
  depends_on: ['site'],
};
const execution = {
  id: 'run-1:task:site',
  provider: 'zai',
  model: 'glm-5.3-flash',
  team_task: 'run-1:task:site',
  status: 'failed',
  error: site.error,
};
const run = {
  id: 'run-1',
  status: 'failed',
  model_budgets: [
    {
      provider: 'zai',
      model: 'glm-5.3-flash',
      max_requests: null,
      requests: 49,
      spend_limit_microusd: null,
      charged_microusd: 0,
    },
  ],
};
function card(task: Record<string, any>, onRetry = vi.fn(), runRecord: Record<string, any> = run) {
  const props = {
    task,
    tasks: [site, tests].map((item) => (item.task_id === task.task_id ? task : item)),
    run: runRecord,
    snapshot: {
      repository: { id: 'repo' },
      executions: [execution],
      team_tasks: [],
      team_handoffs: [],
      capabilities: { collaborative_runs: 1 },
    } as any,
    busy: false,
    onRetry,
    onRepair: async () => true,
  };
  return {
    onRetry,
    element: TeamTaskCard(props),
    html: renderToStaticMarkup(createElement(TeamTaskCard, props)),
  };
}

describe('retry after a timeout', () => {
  it('offers a working Retry that resumes, even past the three-attempt cap', () => {
    const { element, onRetry, html } = card(site);
    const button = find(element, 'Retry task');
    expect(button).toBeDefined();
    expect(button?.props.disabled).toBe(false);
    button?.props.onClick();
    expect(onRetry).toHaveBeenCalledWith(site);
    expect(html).toContain('continues from the files this attempt already wrote');
    expect(html).not.toMatch(/Restart run|time limit for this model/);
  });

  it('replaces the restart-run and time-limit instructions with plain retry guidance', () => {
    const notice = providerFailureNotice(execution, 'EXECUTION_TIMEOUT');
    expect(`${notice.title} ${notice.action}`).not.toMatch(/Restart run|time limit for this model/);
    expect(notice.action).toContain('Use Retry task');
    expect(notice.action).toContain('dependent tasks start when it succeeds');
    expect(
      providerFailureNotice(
        {
          ...execution,
          error:
            'EXECUTION_TIMEOUT: No agent progress for 5 min (no model response, tool call or file change).',
        },
        'EXECUTION_TIMEOUT',
      ).title,
    ).toBe('Agent stopped after several minutes without progress');
  });

  it('tells the blocked dependent task to wait for the retry instead of a fresh run', () => {
    const { html } = card(tests);
    expect(html).toContain(
      'Blocked until Build Chicago laundry pickup order site (public/) succeeds',
    );
  });

  it('only blocks Retry for a real limit, and names it with numbers', () => {
    expect(retryBlocker(site, [site, tests], run, execution)).toBeUndefined();
    const spent = {
      ...run,
      model_budgets: [
        { ...run.model_budgets[0], spend_limit_microusd: 500_000, charged_microusd: 500_000 },
      ],
    };
    expect(retryBlocker(site, [site, tests], spent, execution)).toBe(
      'Retry is blocked by the approved spend allowance for glm-5.3-flash: $0.50 of $0.50 is used.',
    );
    const { html } = card(site, vi.fn(), spent);
    expect(html).not.toContain('Retry task</button>');
    expect(html).toContain('$0.50 of $0.50 is used');
    // A task that failed on its merits still stops at three attempts.
    const merits = { ...site, error: 'WRITE_SCOPE: wrote outside its paths' };
    expect(
      retryBlocker(merits, [merits, tests], run, { ...execution, error: merits.error }),
    ).toContain('three approved attempts');
  });
});
