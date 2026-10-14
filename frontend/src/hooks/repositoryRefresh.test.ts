import { describe, expect, it } from 'vitest';
import type { RepositoryOverview, RunDetail, RunsPage, Snapshot } from '../lib/types';
import { refreshRepository } from './repositoryRefresh';
import { emptySnapshot } from './repositorySnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const overview = {
  repository: { id: 'repo', policy: { digest: 'current' } },
  watermark: 12,
  capabilities: {},
} as unknown as RepositoryOverview;
const page: RunsPage = {
  items: [
    { id: 'latest', status: 'ready' },
    { id: 'active', status: 'exploring' },
  ],
  watermark: 12,
  has_more: false,
  next_cursor: null,
};
const detail = (id: string) =>
  ({
    ...emptySnapshot(overview),
    run: { id },
    runs: [{ id, status: 'ready' }],
    candidates: [{ id: `candidate:${id}`, run_id: id }],
  }) as unknown as RunDetail;
const ticks = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('progressive repository reads', () => {
  it('makes the checked latest run usable while an unrelated active detail is delayed, then retains both', async () => {
    const slow = deferred<RunDetail>();
    const views: Snapshot[] = [];
    const load = async <T>(path: string): Promise<T> =>
      (path.endsWith('/overview')
        ? overview
        : path.includes('/runs?')
          ? page
          : path.endsWith('/latest')
            ? detail('latest')
            : await slow.promise) as T;
    const pending = refreshRepository({
      id: 'repo',
      load,
      isCurrent: () => true,
      onSnapshot: (value) => views.push(value),
    });
    await ticks();
    expect(views.at(-1)?.runs.map((run) => run.id)).toEqual(['latest']);
    expect(views.at(-1)?.candidates[0].id).toBe('candidate:latest');
    slow.resolve(detail('active'));
    await pending;
    expect(views.at(-1)?.runs.map((run) => run.id)).toEqual(['active', 'latest']);
    expect(views.at(-1)?.candidates).toHaveLength(2);
  });

  it('loads an exact deep link in parallel without waiting for history or offering a false empty state', async () => {
    const slowHistory = deferred<RunsPage>();
    const views: Snapshot[] = [];
    const paths: string[] = [];
    const load = async <T>(path: string): Promise<T> => {
      paths.push(path);
      return (
        path.endsWith('/overview')
          ? overview
          : path.includes('/runs?')
            ? await slowHistory.promise
            : detail(path.split('/').at(-1) ?? '')
      ) as T;
    };
    const pending = refreshRepository({
      id: 'repo',
      requestedRunId: 'older',
      load,
      isCurrent: () => true,
      onSnapshot: (value) => views.push(value),
    });
    await ticks();
    expect(views.at(-1)?.runs[0].id).toBe('older');
    expect(paths.filter((path) => path.includes('cursor'))).toEqual([]);
    slowHistory.resolve(page);
    await pending;
    expect(views.at(-1)?.runs.at(-1)?.id).toBe('latest');
  });

  it('never emits delayed evidence after repository selection or account ownership changes', async () => {
    const slow = deferred<RunDetail>();
    let current = true;
    const views: Snapshot[] = [];
    const load = async <T>(path: string): Promise<T> =>
      (path.endsWith('/overview')
        ? overview
        : path.includes('/runs?')
          ? page
          : await slow.promise) as T;
    const pending = refreshRepository({
      id: 'repo',
      load,
      isCurrent: () => current,
      onSnapshot: (value) => views.push(value),
    });
    await ticks();
    expect(views).toEqual([]);
    current = false;
    slow.resolve(detail('latest'));
    await pending;
    expect(views).toEqual([]);
  });

  it('rejects a detail from another repository instead of displaying its checks', async () => {
    const load = async <T>(path: string): Promise<T> =>
      (path.endsWith('/overview')
        ? overview
        : path.includes('/runs?')
          ? page
          : { ...detail('latest'), repository: { id: 'other' } }) as T;
    const views: Snapshot[] = [];
    await expect(
      refreshRepository({
        id: 'repo',
        load,
        isCurrent: () => true,
        onSnapshot: (value) => views.push(value),
      }),
    ).rejects.toThrow('repository');
    expect(views).toEqual([]);
  });
});
