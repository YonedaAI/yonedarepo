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
function render(reviewer = false) {
  hooks.cursor = 0;
  hooks.refCursor = 0;
  return ConflictStatusPanel({ repository, reviewer, onChange: async () => {}, onError: () => {} });
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.cursor = 0;
  hooks.refCursor = 0;
  hooks.effects = [];
  apiMock.mockReset();
});

const inventory = {
  records: [
    {
      kind: 'stale_candidate',
      candidate_id: 'candidate-stale',
      head_commit: 'head-6',
      expected_version: 6,
      conflict_paths: ['src/old.rs'],
      evidence: { reason: 'base_moved' },
    },
    {
      id: 'conflict-1',
      kind: 'unresolved_conflict',
      candidate_id: 'candidate-1',
      status: 'unresolved',
      head_commit: 'head-7',
      expected_version: 7,
      conflict_paths: ['src/a.rs'],
      evidence: { reason: 'head_changed' },
    },
  ],
  overlaps: [
    {
      conflict_id: 'conflict-1',
      candidate_id: 'candidate-1',
      paths: ['src/a.rs', 'src/shared.rs'],
      status: 'overlap',
    },
  ],
  seq: 4,
};

describe('backend conflict inventory normalization and repair actions', () => {
  it('uses an owner brief and retries the identical CAS request after an uncertain failure', async () => {
    apiMock
      .mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error('Acknowledgment lost'))
      .mockResolvedValueOnce({ status: 'repair_started' });
    let tree = render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() =>
      expect(hooks.states[0]).toMatchObject({
        records: [
          { key: 'candidate:candidate-stale', kind: 'stale_candidate' },
          { key: 'conflict:conflict-1', kind: 'unresolved_conflict', conflict_id: 'conflict-1' },
        ],
        overlaps: [{ candidate_id: 'candidate-1', paths: ['src/a.rs', 'src/shared.rs'] }],
      }),
    );
    tree = render();
    expect(renderToStaticMarkup(tree)).toContain('Overlapping task paths');
    expect(renderToStaticMarkup(tree)).toContain('src/shared.rs');
    expect(renderToStaticMarkup(tree)).toContain('candidate-1');
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

  it('keys id-less stale candidates by candidate ID and refreshes without a conflict ID', async () => {
    apiMock.mockResolvedValueOnce(inventory).mockResolvedValueOnce({ status: 'refreshed' });
    let tree = render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toBeTruthy());
    tree = render();
    find(tree, 'button', 'Refresh candidate')?.props.onClick();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock.mock.calls[1][0]).toBe('repos/repo/refresh_candidate');
    expect(apiMock.mock.calls[1][1]).toMatchObject({
      candidate_id: 'candidate-stale',
      expected_commit: 'head-8',
      expected_version: 8,
      declared_paths: ['src/old.rs'],
      request_id: expect.any(String),
    });
    expect(apiMock.mock.calls[1][1]).not.toHaveProperty('conflict_id');
  });

  it('shows reviewer refresh and resolver controls with the existing approval label', async () => {
    apiMock.mockResolvedValueOnce(inventory);
    let tree = render(true);
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toBeTruthy());
    tree = render(true);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Refresh candidate using existing trial approval');
    expect(html).toContain('Resolve using existing trial approval');
    expect(html).toContain('existing reviewer approval and shared trial allowance');
  });

  it('shows lifecycle references, offers refresh for failed or stale records, and briefs only unresolved', async () => {
    const lifecycle = {
      conflicts: [
        {
          id: 'clean-1',
          candidate_id: 'candidate-old',
          status: 'clean',
          refreshed_candidate_id: 'candidate-new',
        },
        { id: 'failed-1', candidate_id: 'candidate-failed', status: 'failed' },
        { id: 'stale-1', candidate_id: 'candidate-stale-record', status: 'stale' },
        { id: 'unresolved-1', candidate_id: 'candidate-open', status: 'unresolved' },
      ],
      overlaps: [],
      seq: 5,
    };
    apiMock.mockResolvedValueOnce(lifecycle);
    let tree = render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toBeTruthy());
    tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Lifecycle status: clean.');
    expect(html).toContain('Refreshed candidate: <code>candidate-new</code>');
    expect(html).toContain('Lifecycle status: failed.');
    expect(html).toContain('Lifecycle status: stale.');
    expect((html.match(/Owner brief for the scoped resolver/g) ?? []).length).toBe(1);
    expect((html.match(/>Refresh candidate</g) ?? []).length).toBe(2);
  });

  it('polls active lifecycle records in the background and stops after a terminal status', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(123);
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    hooks.states[0] = {
      records: [{ key: 'conflict:1', status: 'refreshing', conflict_paths: [] }],
      overlaps: [],
      seq: 1,
    };
    apiMock.mockResolvedValue({ conflicts: [], overlaps: [], seq: 2 });
    render();
    const pollingEffect = hooks.effects.at(-1);
    const cleanup = pollingEffect?.() as (() => void) | undefined;
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval.mock.calls[0][1]).toBe(2000);
    const poll = setInterval.mock.calls[0][0] as () => void;
    poll();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith('repos/repo/conflict_status'));
    cleanup?.();
    expect(clearInterval).toHaveBeenCalledWith(123);

    hooks.states[0] = {
      records: [{ key: 'conflict:1', status: 'clean', conflict_paths: [] }],
      overlaps: [],
      seq: 2,
    };
    render();
    const terminalEffect = hooks.effects.at(-1);
    expect(terminalEffect?.()).toBeUndefined();
    expect(setInterval).toHaveBeenCalledTimes(1);
    setInterval.mockRestore();
    clearInterval.mockRestore();
  });
});
