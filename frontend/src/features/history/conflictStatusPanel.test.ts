import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repository } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  refCursor: 0,
  effects: [] as (() => unknown)[],
}));
const apiMock = vi.hoisted(() => vi.fn());
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
  useRef: (initial: unknown) => {
    const index = hooks.refCursor++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
  useCallback: (callback: (...args: any[]) => unknown) => callback,
}));
vi.mock('../../lib/api', () => ({ api: apiMock }));

import { ConflictStatusPanel } from './ConflictStatusPanel';

const repository: Repository = {
  id: 'repo',
  name: 'Repo',
  version: 8,
  status: 'blocked',
  head_commit: 'head-8',
  published_commit: 'published-6',
  pending: null,
  remote: { namespace: 'test', name: 'repo' },
};
function find(
  element: ReactNode,
  type: string,
  label?: string,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type, label)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  if (item.type === type && (!label || String(item.props.children).includes(label))) return item;
  return find(item.props.children, type, label);
}
function render() {
  hooks.cursor = 0;
  hooks.refCursor = 0;
  return ConflictStatusPanel({ repository, onChange: async () => {}, onError: () => {} });
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.cursor = 0;
  hooks.refCursor = 0;
  hooks.effects = [];
  apiMock.mockReset();
});

describe('owner conflict repair requests', () => {
  it('uses an owner brief and retries the identical CAS request after an uncertain failure', async () => {
    const inventory = {
      conflicts: [
        {
          conflict_id: 'conflict-1',
          candidate_id: 'candidate-1',
          status: 'stale',
          expected_commit: 'head-7',
          declared_paths: ['src/a.rs'],
        },
      ],
      overlaps: [{ path: 'src/a.rs', candidates: ['task-a', 'task-b'], status: 'overlap' }],
      seq: 4,
    };
    apiMock
      .mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error('Acknowledgment lost'))
      .mockResolvedValueOnce({ status: 'repair_started' });
    let tree = render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual(inventory));
    tree = render();
    expect(renderToStaticMarkup(tree)).toContain('Overlapping task paths');
    find(tree, 'textarea')?.props.onChange({
      target: { value: 'Repair only the overlapping source path and rerun checks.' },
    });
    tree = render();
    find(tree, 'button', 'Resolve with fresh capture and checks')?.props.onClick();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    const first = apiMock.mock.calls[1][1];
    expect(first).toMatchObject({
      request_id: expect.any(String),
      conflict_id: 'conflict-1',
      owner_brief: 'Repair only the overlapping source path and rerun checks.',
      expected_commit: 'head-8',
      expected_version: 8,
      candidate_id: 'candidate-1',
      declared_paths: ['src/a.rs'],
    });
    tree = render();
    expect(renderToStaticMarkup(tree)).toContain('Retry scoped repair request');
    find(tree, 'button', 'Retry scoped repair request')?.props.onClick();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
    expect(apiMock.mock.calls[2][1]).toEqual(first);
    expect(first.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
