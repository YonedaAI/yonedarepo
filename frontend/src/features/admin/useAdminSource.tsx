import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { onSourceWrite } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';
import { AdminReadStore } from './adminReadStore';

const Reports = createContext<AdminReadStore | null>(null);

/** Key the provider by viewer: changing account or leaving Admin discards all snapshots. */
export function AdminReadScope({ children }: { children: ReactNode }) {
  const store = useRef<AdminReadStore | null>(null);
  store.current ??= new AdminReadStore();
  useEffect(() => onSourceWrite(() => store.current?.clear()), []);
  return <Reports value={store.current}>{children}</Reports>;
}

export function useAdminSource<T extends object>(path: string) {
  const store = useContext(Reports);
  const seed = useRef({ data: store?.get<T>(path), generation: store?.generation ?? 0 });
  const loaded = useSource<T>(path, undefined, seed.current.data);
  useEffect(() => {
    // Only a new answer refreshes expiry. Reusing a seed never makes it fresh again.
    if (
      loaded.current &&
      !loaded.loading &&
      loaded.data &&
      loaded.data !== seed.current.data &&
      !('ok' in loaded.data && loaded.data.ok === false)
    )
      store?.put(path, loaded.data, seed.current.generation);
  }, [store, path, loaded.current, loaded.loading, loaded.data]);
  return loaded;
}
