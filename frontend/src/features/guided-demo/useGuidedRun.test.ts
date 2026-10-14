import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail, Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
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
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));
vi.mock('../../lib/api', () => ({ api: apiMock }));

import { useGuidedRun } from './useGuidedRun';

const repository = {
  id: 'repo',
  name: 'repo',
  version: 1,
  status: 'ready',
  head_commit: 'head',
  published_commit: 'head',
  pending: null,
  remote: { namespace: 'test', name: 'repo' },
} as Snapshot['repository'];
const snapshot = (seq: number, head = 'head'): Snapshot => ({
  repository: { ...repository, head_commit: head },
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq,
  graph_paged: true,
});
const detail = (seq: number) =>
  ({
    ...snapshot(seq),
    runs: [{ id: 'guided-run', status: 'running', created_at: 1, intent: 'Guided' }],
  }) as unknown as RunDetail;
const run = (value: Snapshot) => {
  hooks.cursor = 0;
  return useGuidedRun(value, 'guided-run');
};

beforeEach(() => {
  hooks.states = [];
  hooks.effects = [];
  apiMock.mockReset();
});

describe('guided run detail during live updates', () => {
  it('blocks only the first read, then keeps the last detail rendered while revalidating', async () => {
    apiMock.mockResolvedValueOnce(detail(1));
    expect(run(snapshot(1)).loading).toBe(true);
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(run(snapshot(1)).loading).toBe(false));
    expect(run(snapshot(1)).snapshot.runs.map((item) => item.id)).toEqual(['guided-run']);

    // A live resync advances the repository past the loaded detail.
    const newer = run(snapshot(2, 'new-head'));
    expect(newer.loading).toBe(false);
    expect(newer.refreshing).toBe(true);
    expect(newer.snapshot.runs.map((item) => item.id)).toEqual(['guided-run']);
    expect(newer.snapshot.repository.head_commit).toBe('new-head');
    expect(newer.snapshot.seq).toBe(2);
  });

  it('keeps the rendered run when a background revalidation fails', async () => {
    apiMock.mockResolvedValueOnce(detail(1));
    run(snapshot(1));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(run(snapshot(1)).loading).toBe(false));
    apiMock.mockRejectedValueOnce(new Error('The request timed out.'));
    hooks.effects.length = 0;
    run(snapshot(2));
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(run(snapshot(2)).refreshError).toBe('The request timed out.'));
    const after = run(snapshot(2));
    expect(after.error).toBe('');
    expect(after.loading).toBe(false);
    expect(after.snapshot.runs.map((item) => item.id)).toEqual(['guided-run']);
  });
});
