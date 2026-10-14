import { useCallback, useEffect, useState } from 'react';
import type { GuidedStepId } from '../../../../shared/guided-runs';
import type { Snapshot } from '../../lib/types';
import { GuidedSessionPanel } from './GuidedSessionPanel';
import { type GuideRefreshState, refreshGuideAndSnapshot } from './guidedRefresh';
import { guideEvidenceRun } from './guideEvidenceRun';
import { useGuidedRunFacts } from './useGuidedRunFacts';
import { useGuidedSession } from './useGuidedSession';
export function GuidedWorkspace({
  snapshot,
  sessionId,
  onSession,
  onInspect,
  onProviders,
  onState,
  onRefreshSnapshot,
}: {
  snapshot: Snapshot;
  sessionId: string;
  onSession: (repo: string, session: string) => void;
  onInspect: (run: string, step: GuidedStepId, candidate?: string, kind?: string) => void;
  onProviders: () => void;
  /** Re-reads the repository snapshot alongside a manual guide refresh. */
  onRefreshSnapshot?: () => Promise<void>;
  onState?: (session: import('../../../../shared/guided-runs').GuidedSession) => void;
}) {
  const remember = useCallback(
    (id: string) => onSession(snapshot.repository.id, id),
    [snapshot.repository.id, onSession],
  );
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');
  const inspect = async (run: string, step: GuidedStepId, candidate?: string, kind?: string) => {
    if (opening) return;
    setOpening(true);
    setOpenError('');
    try {
      const id =
        run ||
        (state.session && candidate
          ? await guideEvidenceRun(snapshot, state.session, candidate)
          : '');
      if (!id) throw new Error('Refresh the guide to confirm the result’s recorded run.');
      onInspect(id, step, candidate, kind);
    } catch (error) {
      setOpenError((error as Error).message);
    } finally {
      setOpening(false);
    }
  };
  const state = useGuidedSession(
    snapshot,
    sessionId,
    remember,
    (run, step, candidate) => void inspect(run, step, candidate),
  );
  const runFacts = useGuidedRunFacts(snapshot, state.session);
  const [refreshState, setRefreshState] = useState<GuideRefreshState>({ refreshing: false });
  async function refreshGuide() {
    if (refreshState.refreshing) return;
    setRefreshState((previous) => ({ ...previous, refreshing: true, error: undefined }));
    const read = await refreshGuideAndSnapshot(state.refresh, onRefreshSnapshot);
    setRefreshState((previous) =>
      read
        ? { refreshing: false, refreshedAt: Date.now() }
        : { ...previous, refreshing: false, error: 'Could not refresh the guide. Try again.' },
    );
  }
  useEffect(() => {
    if (state.session) onState?.(state.session);
  }, [state.session, onState]);
  return (
    <div className="guided-page">
      <p className="subtle guided-connections">
        Models and roles are selected automatically from your connections.{' '}
        <button type="button" className="text-button" onClick={onProviders}>
          Manage connections
        </button>
      </p>
      {(state.error || openError) && <p role="alert">{state.error || openError}</p>}
      {opening && <p role="status">Opening the result’s current source and checks…</p>}
      {state.session ? (
        <GuidedSessionPanel
          session={state.session}
          busy={state.busy || opening}
          onStart={(step) => void state.start(step)}
          onRetry={(step) => void state.retry(step)}
          onInspect={(run, step, candidate, kind) => void inspect(run, step, candidate, kind)}
          refresh={refreshState}
          runs={runFacts}
          onRefresh={() => void refreshGuide()}
        />
      ) : (
        <section className="guided-demo" aria-label="Guided demo">
          <h2>Your guided task board</h2>
          <p role="status">
            {state.loading
              ? 'Preparing your guide…'
              : 'The guide is not available yet. Refresh to check project setup.'}
          </p>
          <button type="button" className="quiet" onClick={() => void state.refresh()}>
            Refresh guide
          </button>
        </section>
      )}
    </div>
  );
}
