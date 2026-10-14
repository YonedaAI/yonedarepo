import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuidedSession, GuidedStepId } from '../../../../shared/guided-runs';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { createGuidedStepStart, readGuidedSession } from './guidedClient';
import { guidedStartJournal } from './guidedStartJournal';
import { guidedRetryInput, guidedStepInput } from './guidedStepInput';
export function useGuidedSession(
  snapshot: Snapshot,
  sessionId: string,
  onSession: (id: string) => void,
  onInspect: (run: string, step: GuidedStepId, candidate?: string) => void,
) {
  const repo = snapshot.repository.id;
  const [session, setSession] = useState<GuidedSession>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const starts = useRef(new Map<string, ReturnType<typeof createGuidedStepStart>>());
  const active = useRef(true),
    read = useRef<AbortController | undefined>(undefined);
  /** `superseded` means a newer read (e.g. the running-step poll) replaced this one. */
  const refresh = useCallback(async (): Promise<'applied' | 'superseded' | 'failed'> => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const result = readGuidedSession(
        await api<unknown>(`repos/${encodeURIComponent(repo)}/guided_session${query}`, undefined, {
          signal: controller.signal,
        }),
        sessionId || undefined,
      );
      if (active.current && !controller.signal.aborted) {
        setSession(result);
        onSession(result.session_id);
        setError('');
        return 'applied';
      }
      return 'superseded';
    } catch (failure) {
      if (!active.current || controller.signal.aborted) return 'superseded';
      setError((failure as Error).message);
      return 'failed';
    } finally {
      if (active.current && !controller.signal.aborted) setLoading(false);
    }
  }, [repo, sessionId, onSession]);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      read.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!session?.steps.some((step) => step.status === 'running')) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [session, refresh]);
  /** One frozen request per first start, and per retry of each failed attempt. */
  const submit = async (stepId: GuidedStepId, retryFrom?: number) => {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const key = retryFrom === undefined ? stepId : `${stepId}:retry-${retryFrom}`;
      let controller = starts.current.get(key);
      if (!controller) {
        controller = createGuidedStepStart(
          repo,
          api,
          guidedStartJournal(repo, session.session_id, stepId, window.sessionStorage, retryFrom),
          retryFrom,
        );
        starts.current.set(key, controller);
      }
      const result = await controller.start(
        retryFrom === undefined
          ? guidedStepInput(session, stepId, snapshot.repository)
          : guidedRetryInput(session, stepId, snapshot.repository),
      );
      if (!active.current) return;
      setSession(result);
      onSession(result.session_id);
      const stage = result.steps.find((item) => item.id === stepId);
      const run = stage?.run_ids.at(-1);
      if (stepId === 'review' && stage?.candidate_id)
        onInspect(run ?? '', stepId, stage.candidate_id);
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const start = async (stepId: GuidedStepId) => {
    const step = session?.steps.find((item) => item.id === stepId);
    if (
      busy ||
      !session ||
      session.next_step !== stepId ||
      step?.status !== 'ready' ||
      !step.next_action ||
      session.steps.some((item) => item.status === 'running')
    )
      return;
    await submit(stepId);
  };
  const retry = async (stepId: GuidedStepId) => {
    const step = session?.steps.find((item) => item.id === stepId);
    if (busy || !session || step?.status !== 'needs_attention') return;
    await submit(stepId, step.attempt ?? 1);
  };
  return { session, error, busy, loading, refresh, start, retry };
}
