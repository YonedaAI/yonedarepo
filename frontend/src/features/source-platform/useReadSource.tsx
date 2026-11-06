import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { ReadSnapshotStore } from './readSnapshotStore';
import { type ApiInit, onSourceWrite } from './sourceApi';
import { useSource } from './useSource';

const Reports = createContext<ReadSnapshotStore | null>(null);

/** Key the provider by viewer: changing account or leaving its page scope discards all snapshots. */
export function ReadScope({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const store = useRef<ReadSnapshotStore | null>(null);
  store.current ??= new ReadSnapshotStore();
  useEffect(() => {
    return onSourceWrite(() => store.current?.clear());
  }, []);
  return <Reports value={enabled ? store.current : null}>{children}</Reports>;
}

export function useReadSource<T extends object>(path: string | null, base?: ApiInit['base']) {
  const store = useContext(Reports);
  const key = `${base ?? '/api/v1'}${path ?? ''}`;
  const seed = useRef({
    data: path ? store?.get<T>(key) : undefined,
    generation: store?.generation ?? 0,
  });
  const loaded = useSource<T>(path, base, seed.current.data);
  useEffect(() => {
    // Only a new answer refreshes expiry. Reusing a seed never makes it fresh again.
    if (
      path !== null &&
      loaded.current &&
      !loaded.loading &&
      loaded.data &&
      loaded.data !== seed.current.data &&
      !('ok' in loaded.data && loaded.data.ok === false) &&
      !('partial' in loaded.data && loaded.data.partial)
    )
      store?.put(key, loaded.data, seed.current.generation);
  }, [store, path, key, loaded.current, loaded.loading, loaded.data]);
  return loaded;
}
