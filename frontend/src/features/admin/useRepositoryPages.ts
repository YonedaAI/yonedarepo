// Keep the operator's current rows in place while another server order loads. Every
// continuation belongs to one committed query/reload; old completions cannot join it.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RepositoryPage } from '../../../../shared/admin-repositories';
import { sourceApi } from '../source-platform/sourceApi';
import { useSource } from '../source-platform/useSource';

export function useRepositoryPages(path: string, pathOf: (cursor: string) => string) {
  const first = useSource<RepositoryPage>(path);
  const [generation, setGeneration] = useState(0);
  const request = useMemo(() => ({ path, generation }), [path, generation]);
  const active = useRef<typeof request | null>(request);
  const pending = useRef<{ request: typeof request; controller: AbortController } | null>(null);
  const [later, setLater] = useState({
    request,
    pages: [] as RepositoryPage[],
    busy: false,
    error: '',
  });
  useLayoutEffect(() => {
    active.current = request;
    return () => {
      if (active.current === request) active.current = null;
      if (pending.current?.request === request) pending.current.controller.abort();
    };
  }, [request]);
  const retained = later.request === request || first.current === false;
  const pages = first.data ? [first.data, ...(retained ? later.pages : [])] : [];
  const partial = pages.some((page) => page.partial);
  const loading = first.loading || first.current === false;
  const next = loading || partial ? null : (pages.at(-1)?.next ?? null);
  const busy = later.request === request && later.busy;
  async function more() {
    if (next === null || busy || pending.current?.request === request) return;
    const controller = new AbortController();
    pending.current = { request, controller };
    setLater({
      request,
      pages: later.request === request ? later.pages : [],
      busy: true,
      error: '',
    });
    try {
      const page = await sourceApi<RepositoryPage>(pathOf(next), { signal: controller.signal });
      if (active.current === request && !controller.signal.aborted)
        setLater((state) => ({
          request,
          pages: [...(state.request === request ? state.pages : []), page],
          busy: false,
          error: '',
        }));
    } catch (error) {
      if (active.current === request && !controller.signal.aborted)
        setLater((state) => ({ ...state, busy: false, error: (error as Error).message }));
    } finally {
      if (pending.current?.controller === controller) pending.current = null;
    }
  }
  return {
    items: pages.flatMap((page) => page.items),
    first: { ...first, loading },
    next,
    busy,
    partial,
    error: later.request === request ? later.error : '',
    more,
    reload: () => {
      if (pending.current?.request === request) pending.current.controller.abort();
      setGeneration((value) => value + 1);
      first.reload();
    },
  };
}
