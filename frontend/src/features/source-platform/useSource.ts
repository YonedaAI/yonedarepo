import { useCallback, useEffect, useState } from 'react';
import { SourceApiError, sourceApi } from './sourceApi';

export type Loaded<T> = {
  data?: T;
  error?: string;
  /** The HTTP status of a failed read (404 tells "missing or private" apart from a fault). */
  errorStatus?: number;
  loading: boolean;
  reload: () => void;
};

/** GETs `path` (null skips), cancelling stale reads when the path changes. */
export function useSource<T = any>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    errorStatus?: number;
    loading: boolean;
  }>({
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the same path.
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined, errorStatus: undefined }));
    sourceApi<T>(path, { signal: controller.signal })
      .then((data) => setState({ data, loading: false }))
      .catch((e) => {
        if (!controller.signal.aborted)
          setState({
            error: e.message,
            errorStatus: e instanceof SourceApiError ? e.status : undefined,
            loading: false,
          });
      });
    return () => controller.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
