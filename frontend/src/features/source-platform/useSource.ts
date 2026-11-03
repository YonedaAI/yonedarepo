import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiInit, SourceApiError, sourceApi } from './sourceApi';

export type Loaded<T> = {
  data?: T;
  error?: string;
  /** The HTTP status of a failed read (404 tells "missing or private" apart from a fault). */
  errorStatus?: number;
  /** The platform's error code (e.g. NOT_FOUND) when the read failed. */
  code?: string;
  loading: boolean;
  reload: () => void;
};

/** GETs `path` (null skips), cancelling stale reads when the path changes. `base` reads the
 * managed agents Worker instead of the platform. */
export function useSource<T = any>(
  path: string | null,
  base?: ApiInit['base'],
  initial?: T,
): Loaded<T> {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    errorStatus?: number;
    code?: string;
    loading: boolean;
  }>({
    data: initial,
    loading: initial === undefined && path !== null,
  });
  const [tick, setTick] = useState(0);
  // A navigation's fresh response is already admitted. It is never a reusable cache:
  // changing the request or explicitly reloading permanently ends this initial value.
  const seeded = useRef(initial === undefined ? undefined : { path, base });
  if (seeded.current && (seeded.current.path !== path || seeded.current.base !== base || tick > 0))
    seeded.current = undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the same path.
  useEffect(() => {
    if (seeded.current) return;
    if (path === null) {
      setState((current) => (current.loading ? { ...current, loading: false } : current));
      return;
    }
    const controller = new AbortController();
    setState((s) => ({
      ...s,
      loading: true,
      error: undefined,
      errorStatus: undefined,
      code: undefined,
    }));
    sourceApi<T>(path, { signal: controller.signal, base })
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const failed = e instanceof SourceApiError ? e : undefined;
        setState({
          error: e.message,
          errorStatus: failed?.status,
          code: failed?.code,
          loading: false,
        });
      });
    return () => controller.abort();
  }, [path, base, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
