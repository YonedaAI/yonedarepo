import { useCallback, useEffect, useRef, useState } from 'react';
import { readVersionPage, type VersionPage } from './versionPages';

export function useVersions(
  repo: string,
  recent: boolean | undefined,
  known: number | undefined,
  compact = false,
) {
  const [tick, refresh] = useState(0);
  const key = `${repo}/${recent}/${known}/${compact}/${tick}`;
  const [state, setState] = useState<{
    key: string;
    page?: VersionPage;
    error?: string;
    loading: boolean;
    newer: VersionPage[];
  }>({ key, loading: true, newer: [] });
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (recent === undefined || known === undefined) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ key, loading: true, newer: [] });
    readVersionPage(repo, recent, known, compact, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setState({ key, page, loading: false, newer: [] });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setState({ key, error: e.message, loading: false, newer: [] });
      });
    return () => controller.abort();
  }, [key, repo, recent, known, compact]);
  const current = state.key === key ? state : { key, loading: true, newer: [] };
  const loadPage = async (older: boolean) => {
    if (
      !current.page ||
      (older ? !current.page.next_before : !current.newer.length) ||
      current.loading ||
      recent === undefined ||
      known === undefined
    )
      return;
    const controller = active.current;
    if (!controller || controller.signal.aborted) return;
    setState({ ...current, loading: true });
    try {
      const previous = older ? current.page : current.newer.at(-1);
      const page = await readVersionPage(repo, recent, known, compact, controller.signal, previous);
      if (!controller.signal.aborted)
        setState({
          key,
          page,
          loading: false,
          newer: older
            ? [
                ...current.newer,
                {
                  ...current.page,
                  entries: [],
                  next_before: (current.page.entries[0]?.version ?? 0) + 1,
                },
              ]
            : current.newer.slice(0, -1),
        });
    } catch (e) {
      if (!controller.signal.aborted)
        setState({ key, error: (e as Error).message, loading: false, newer: [] });
    }
  };
  const reload = useCallback(() => refresh((n) => n + 1), []);
  return { ...current, loadOlder: () => loadPage(true), loadNewer: () => loadPage(false), reload };
}
