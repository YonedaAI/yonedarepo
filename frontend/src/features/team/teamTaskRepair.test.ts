import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] =
          typeof value === 'function'
            ? (value as (current: unknown) => unknown)(hooks.states[index])
            : value;
      },
    ];
  },
}));

import { TeamTaskCard } from './TeamTaskCard';

function find(element: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  return item.type === type ? item : find(item.props.children, type);
}
const task = {
  id: 'ledger:task-record',
  task_id: 'task-local',
  run_id: 'run-1',
  title: 'Repair specialist output',
  status: 'failed',
  revision: 4,
  epoch: 9,
  role: 'worker',
  output: { revision: { commit: 'old-commit' }, paths: ['src/a.ts'] },
};
function render(onRepair: (request: Record<string, unknown>) => Promise<boolean>) {
  hooks.cursor = 0;
  return TeamTaskCard({
    task,
    tasks: [task],
    run: { id: 'run-1', team_plan_revision: 8 },
    snapshot: {
      repository: { id: 'repo', head_commit: 'current-head', version: 12 },
      executions: [],
      team_tasks: [],
      team_handoffs: [],
    } as any,
    busy: false,
    onRetry: () => {},
    onRepair,
  });
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
});

describe('team task repair request', () => {
  it('collects an inline brief and retries the exact frozen task-scoped request', async () => {
    const onRepair = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let tree = render(onRepair);
    const textarea = find(tree, 'textarea');
    expect(textarea).toBeTruthy();
    textarea?.props.onChange({
      target: { value: 'Repair the failing source path and rerun checks.' },
    });
    tree = render(onRepair);
    const form = find(tree, 'form');
    await form?.props.onSubmit({ preventDefault: () => {} });
    await vi.waitFor(() => expect(hooks.states[2]).toBe(false));
    const first = onRepair.mock.calls[0][0];
    expect(first).toMatchObject({
      run_id: 'run-1',
      expected_plan_revision: 8,
      task_ids: ['task-local'],
      expected_task_revisions: { 'task-local': 4 },
      owner_brief: 'Repair the failing source path and rerun checks.',
      expected_commit: 'current-head',
      expected_version: 12,
      request_id: expect.any(String),
    });
    expect(first).not.toHaveProperty('task_id');
    tree = render(onRepair);
    expect(renderToStaticMarkup(tree)).toContain('Retry same repair request');
    await find(tree, 'form')?.props.onSubmit({ preventDefault: () => {} });
    await vi.waitFor(() => expect(hooks.states[2]).toBe(false));
    expect(onRepair.mock.calls[1][0]).toEqual(first);
    expect(renderToStaticMarkup(render(onRepair))).toContain('Repair request accepted');
  });
});
