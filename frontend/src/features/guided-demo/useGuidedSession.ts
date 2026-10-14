import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuidedSession, GuidedStepId } from '../../../../shared/guided-runs';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { createGuidedStepStart, readGuidedSession } from './guidedClient';
import { guidedStartJournal } from './guidedStartJournal';
import { guidedStepInput } from './guidedStepInput';
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
  const starts = useRef(new Map<GuidedStepId, ReturnType<typeof createGuidedStepStart>>());
  const active = useRef(true),
    read = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async () => {
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
      }
    } catch (failure) {
      if (active.current && !controller.signal.aborted) setError((failure as Error).message);
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
    setBusy(true);
    setError('');
    try {
      let controller = starts.current.get(stepId);
      if (!controller) {
        controller = createGuidedStepStart(
          repo,
          api,
          guidedStartJournal(repo, session.session_id, stepId, window.sessionStorage),
        );
        starts.current.set(stepId, controller);
      }
      const result = await controller.start(guidedStepInput(session, stepId, snapshot.repository));
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
  return { session, error, busy, loading, refresh, start };
}
