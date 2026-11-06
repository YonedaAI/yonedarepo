import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ApiInit, SourceApiError, sourceApi } from './sourceApi';

export type Loaded<T> = {
  data?: T;
  error?: string;
  /** The HTTP status of a failed read (404 tells "missing or private" apart from a fault). */
  errorStatus?: number;
  /** The platform's error code (e.g. NOT_FOUND) when the read failed. */
  code?: string;
  loading: boolean;
  /** Whether data/error belongs to this exact request, rather than retained prior data. */
  current?: boolean;
  reload: () => void;
};

/** GETs `path` (null skips), cancelling stale reads when the path changes. `base` reads the
 * managed agents Worker instead of the platform. */
export function useSource<T = any>(
  path: string | null,
  base?: ApiInit['base'],
  initial?: T,
): Loaded<T> {
  const [tick, setTick] = useState(0);
  // A new identity on every committed transition, including A → B → A and reloads.
  const request = useMemo(() => ({ path, base, tick }), [path, base, tick]);
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    errorStatus?: number;
    code?: string;
    loading: boolean;
    answered?: typeof request;
  }>({
    data: initial,
    loading: initial === undefined && path !== null,
    answered: initial === undefined ? undefined : request,
  });
  // Caller-admitted initial data applies once: repository navigation supplies a fresh
  // response; read-only report scopes enforce their own viewer/TTL policy. Changing the
  // request or explicitly reloading permanently ends this initial value.
  const seeded = useRef(initial === undefined ? undefined : request);
  if (seeded.current !== request) seeded.current = undefined;
  useEffect(() => {
    if (seeded.current === request) return;
    if (request.path === null) {
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
    sourceApi<T>(request.path, { signal: controller.signal, base: request.base })
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false, answered: request });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const failed = e instanceof SourceApiError ? e : undefined;
        setState({
          error: e.message,
          errorStatus: failed?.status,
          code: failed?.code,
          loading: false,
          answered: request,
        });
      });
    return () => controller.abort();
  }, [request]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const { answered, ...loaded } = state;
  return { ...loaded, current: answered === request, reload };
}
