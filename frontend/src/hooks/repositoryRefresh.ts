import { ApiError } from '../lib/api';
import type { RepositoryOverview, RunDetail, RunsPage, Snapshot } from '../lib/types';
import {
  emptySnapshot,
  mergeRunDetails,
  RequestedRunNotFoundError,
  scopedRunIds,
} from './repositorySnapshot';

export interface RepositoryRefreshOptions {
  id: string;
  load: <T>(path: string) => Promise<T>;
  snapshot?: Snapshot | null;
  requestedRunId?: string;
  isCurrent: () => boolean;
  onSnapshot: (snapshot: Snapshot) => void;
  onRequestedRunError?: (message: string) => void;
}

export async function refreshRepository(options: RepositoryRefreshOptions) {
  const { id, load, isCurrent, onSnapshot } = options;
  // Attach rejection handlers immediately, including reads awaited only after first render.
  const capture = async <T>(promise: Promise<T>) => {
    try {
      return { value: await promise };
    } catch (error) {
      return { error };
    }
  };
  const unwrap = <T>(result: { value?: T; error?: unknown }): T => {
    if ('error' in result) throw result.error;
    return result.value as T;
  };
  const history = capture(load<RunsPage>(`repos/${id}/runs?limit=25`));
  const requested = options.requestedRunId;
  const first = requested
    ? capture(load<RunDetail>(`repos/${id}/runs/${encodeURIComponent(requested)}`))
    : undefined;
  const overview = await load<RepositoryOverview>(`repos/${id}/overview`);
  if (!isCurrent()) return;
  if (overview.repository.id !== id)
    throw new Error(
      'The repository response did not match this workspace. Refresh before continuing.',
    );
  let next = options.snapshot?.repository.id === id ? options.snapshot : emptySnapshot(overview);
  let page: RunsPage | undefined;
  const loaded = new Set<string>();
  const publish = (detail?: RunDetail) => {
    if (!isCurrent()) return;
    next = mergeRunDetails(next, detail ? [detail] : [], overview);
    // Hydrating an older active run must not change the default newest selection.
    const order = new Map(page?.items.map((run, index) => [run.id, index]));
    next = {
      ...next,
      runs: [...next.runs].sort(
        (a, b) =>
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(a.id) ?? Number.MAX_SAFE_INTEGER),
      ),
    };
    onSnapshot(next);
  };
  const accept = (runId: string, detail: RunDetail) => {
    if (detail.repository.id !== id || detail.runs.length !== 1 || detail.runs[0].id !== runId)
      throw new Error('The run response did not match this repository. Refresh before continuing.');
    loaded.add(runId);
    publish(detail);
  };
  if (first && requested) {
    const result = await first;
    if (!isCurrent()) return;
    if ('error' in result) {
      if (!(result.error instanceof ApiError) || result.error.code !== 'NOT_FOUND')
        throw result.error;
      options.onRequestedRunError?.(new RequestedRunNotFoundError(requested).message);
    } else {
      accept(requested, result.value);
      options.onRequestedRunError?.('');
    }
  }
  page = unwrap(await history);
  if (!isCurrent()) return;
  const primary = page.items[0]?.id;
  if (typeof primary === 'string' && !loaded.has(primary)) {
    accept(primary, await load<RunDetail>(`repos/${id}/runs/${encodeURIComponent(primary)}`));
  } else if (!loaded.size) publish();
  if (!isCurrent()) return;
  await Promise.all(
    scopedRunIds(page.items, next.runs)
      .filter((runId) => !loaded.has(runId))
      .map(async (runId) => {
        const detail = await load<RunDetail>(`repos/${id}/runs/${encodeURIComponent(runId)}`);
        if (isCurrent()) accept(runId, detail);
      }),
  );
}
