import { useEffect, useRef, useState } from 'react';
import type { ContextUsage } from '../../../../shared/context_usage';
import { api } from '../../lib/api';
import { isContextUsage } from './contextUsageView';

export function useContextUsage(path: string | null, sequence: number) {
  const [result, setResult] = useState<{ path: string; value: ContextUsage } | null>(null);
  const [error, setError] = useState<{ path: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const latestSequence = useRef(sequence);
  latestSequence.current = sequence;
  const load = useRef<(force: boolean) => void>(() => {});
  useEffect(() => {
    if (!path) {
      load.current = () => {};
      setLoading(false);
      return;
    }
    const requestPath = path;
    const run = new URLSearchParams(requestPath.split('?')[1]).get('run_id') ?? '';
    const state = { current: true, busy: false, queued: false, force: false, sequence: -1 };
    async function request(force: boolean) {
      if (!state.current || (!force && state.sequence === latestSequence.current)) return;
      if (state.busy) {
        state.queued = true;
        state.force ||= force;
        return;
      }
      state.busy = true;
      state.sequence = latestSequence.current;
      setLoading(true);
      setError(null);
      try {
        const value = await api<ContextUsage>(requestPath);
        if (state.current) {
          if (!isContextUsage(value, run))
            throw new Error(
              'This deployment returned unsupported context evidence. Refresh after upgrading.',
            );
          setResult({ path: requestPath, value });
        }
      } catch (failure) {
        if (state.current) setError({ path: requestPath, message: (failure as Error).message });
      } finally {
        state.busy = false;
        if (state.current) {
          setLoading(false);
          if (state.queued) {
            const nextForce = state.force;
            state.queued = false;
            state.force = false;
            void request(nextForce);
          }
        }
      }
    }
    load.current = (force) => void request(force);
    void request(false);
    return () => {
      state.current = false;
    };
  }, [path]);
  useEffect(() => {
    if (sequence === latestSequence.current) load.current(false);
  }, [sequence]);
  return {
    data: result?.path === path ? result.value : null,
    error: error?.path === path ? error.message : '',
    loading,
    refresh: () => load.current(true),
  };
}
