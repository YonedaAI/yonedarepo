// The Code tab's reads: a path as directory or file, the log window that dates each entry,
// and the commit messages those entries name.
import { useEffect, useMemo, useState } from 'react';
import { type Activity, directoryActivity, type LogEntry } from './fileActivity';
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

/** Log entries read per directory view: enough to date a typical repository's files. */
export const ACTIVITY_WINDOW = 500;
/** Commit messages fetched per directory view. */
const MESSAGE_READS = 12;

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

/** What last changed each of `names` under `dir` on branch `ref`, from the latest log window. */
export function useActivity(
  repo: string,
  version: number | undefined,
  ref: string,
  dir: string,
  names: string[] | undefined,
  at?: number,
): Map<string, Activity> {
  const until = at ?? version;
  const branch = !ref.startsWith('refs/tags/');
  const log = useSource<{ entries: LogEntry[] }>(
    until !== undefined && names && branch
      ? `/repos/${repo}/txlog?after=${Math.max(0, until - ACTIVITY_WINDOW)}&limit=${ACTIVITY_WINDOW}`
      : null,
  );
  const key = names?.join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `names`.
  return useMemo(
    () =>
      log.data && names ? directoryActivity(log.data.entries, ref, dir, names, at) : new Map(),
    [log.data, ref, dir, key, at],
  );
}

// Commit messages never change: one read per commit for the page's lifetime.
const messageCache = new Map<string, string>();

export function useCommitMessages(repo: string, commits: string[]): Map<string, string> {
  const [, setLoaded] = useState(0);
  const wanted = [...new Set(commits)].filter((c) => !messageCache.has(`${repo}:${c}`));
  const key = wanted.slice(0, MESSAGE_READS).join(',');
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    for (const commit of key.split(',')) {
      sourceApi<{ message: string }>(`/repos/${repo}/commits/${commit}`, {
        signal: controller.signal,
      })
        .then((d) => {
          messageCache.set(`${repo}:${commit}`, d.message.split('\n')[0]);
          setLoaded((n) => n + 1);
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [repo, key]);
  return new Map(
    commits.flatMap((c) => {
      const message = messageCache.get(`${repo}:${c}`);
      return message === undefined ? [] : [[c, message] as const];
    }),
  );
}
