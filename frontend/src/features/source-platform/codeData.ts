// The Code tab's reads: a path as directory or file, and what last changed each of its entries.
import { useEffect, useMemo, useState } from 'react';
import type { Activity } from './fileActivity';
import { SourceApiError, sourceApi } from './sourceApi';
import { useSource } from './useSource';

export type FileBody = {
  commit: string;
  size: number;
  encoding: string;
  content: string;
  executable: boolean;
};
export type Listing =
  | { kind: 'tree'; commit: string; entries: { name: string; type: string; id: string }[] }
  | ({ kind: 'file' } & FileBody);

export function readQuery(ref: string, path: string, at?: number) {
  const params = new URLSearchParams({ path, ref });
  if (at !== undefined) params.set('at', String(at));
  return params.toString();
}

/** Reads `path` as a directory, falling back to a file when it is not one. An unresolved
 * `ref` (a tag before the refs load) waits. */
export function useListing(repo: string, ref: string | undefined, path: string, at?: number) {
  const [state, setState] = useState<{ value?: Listing; error?: string; empty?: boolean }>({});
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the same location.
  useEffect(() => {
    if (ref === undefined) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const base = `/repos/${repo}`;
    setState({});
    sourceApi(`${base}/tree?${readQuery(ref, path, at)}`, { signal })
      .then((tree) => setState({ value: { kind: 'tree', ...tree } }))
      .catch(async (e) => {
        if (signal.aborted) return;
        if (e instanceof SourceApiError && /not a directory/.test(e.message)) {
          const file = await sourceApi(`${base}/blob?${readQuery(ref, path, at)}`, { signal });
          setState({ value: { kind: 'file', ...file } });
        } else if (e instanceof SourceApiError && e.code === 'NOT_FOUND') setState({ empty: true });
        else throw e;
      })
      .catch((e) => !signal.aborted && setState({ error: e.message }));
    return () => controller.abort();
  }, [repo, ref, path, at, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** What last changed each entry of `dir` on branch `ref`, once its listing is there. A tag has
 * no branch to walk, so its rows stay blank. */
export function useActivity(
  repo: string,
  ref: string,
  dir: string,
  ready: boolean,
  at?: number,
): Map<string, Activity> {
  const query = `ref=${encodeURIComponent(ref)}&dir=${encodeURIComponent(dir)}`;
  const log = useSource<{ activity: Record<string, Activity> }>(
    ready && !ref.startsWith('refs/tags/')
      ? `/repos/${repo}/log?${query}${at === undefined ? '' : `&at=${at}`}`
      : null,
  );
  return useMemo(() => new Map(Object.entries(log.data?.activity ?? {})), [log.data]);
}
