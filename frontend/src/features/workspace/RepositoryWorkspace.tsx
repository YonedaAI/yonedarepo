import { ArrowLeft, GitBranch, GitCompareArrows, LoaderCircle, Network } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GuidedSession, GuidedStepId } from '../../../../shared/guided-runs';
import { short } from '../../lib/api';
import type { Graph, Snapshot } from '../../lib/types';
import { Exploration } from '../exploration/Exploration';
import { SiteLink } from '../exploration/SiteLink';
import { GraphWorkspace } from '../graph/GraphWorkspace';
import { GuidedWorkspace } from '../guided-demo/GuidedWorkspace';
import { useGuidedRun } from '../guided-demo/useGuidedRun';
import { ConflictStatusPanel } from '../history/ConflictStatusPanel';
import { HistoryTools } from '../history/HistoryTools';
import type { WorkspacePanel } from './WorkspacePanels';

export function RepositoryWorkspace({
  reviewer = false,
  snapshot,
  initialRunId = '',
  requestedRunError = '',
  onChange,
  onError,
  onPanel,
  onProviders,
  onGuidedDemo,
  guidedSessionId,
  onGuidedSession,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  initialRunId?: string;
  requestedRunError?: string;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onPanel: (panel: WorkspacePanel) => void;
  onProviders?: (refresh?: () => void) => void;
  onGuidedDemo?: () => void;
  guidedSessionId?: string;
  onGuidedSession?: (repo: string, session: string) => void;
}) {
  const nativeGuide =
    snapshot.repository.guided_project?.profile_id === 'task-board-v1' &&
    snapshot.repository.guided_project.version === 1;
  const guideSession = guidedSessionId ?? (nativeGuide ? '' : undefined);
  const [view, setView] = useState(guideSession === undefined ? 'runs' : 'guided');
  const [guideState, setGuideState] = useState<GuidedSession>();
  const [guidedRunId, setGuidedRunId] = useState('');
  const guidedRun = useGuidedRun(snapshot, guidedRunId);
  const visible = { ...(guidedRunId ? guidedRun.snapshot : snapshot), guided_session: guideState };
  useEffect(() => {
    if (guidedSessionId !== undefined || !onGuidedSession) return;
    if (nativeGuide) {
      onGuidedSession(snapshot.repository.id, '');
      return;
    }
    const bound = snapshot.runs.find(
      (run) => run.guided?.version === 1 && run.guided?.profile_id === 'task-board-v1',
    );
    if (typeof bound?.guided?.session_id === 'string')
      onGuidedSession(snapshot.repository.id, bound.guided.session_id);
  }, [snapshot.runs, snapshot.repository.id, guidedSessionId, onGuidedSession, nativeGuide]);
  function inspectGuideRun(runId: string, _step: GuidedStepId, _candidate?: string, kind?: string) {
    setGuidedRunId(runId);
    setEvidenceRun(runId);
    setView(kind?.includes('conflict') ? 'history' : kind?.includes('context') ? 'graph' : 'runs');
  }
  const [evidenceRun, setEvidenceRun] = useState('');
  const [history, setHistory] = useState<Graph | null>(null);
  const repo = snapshot.repository;
  return (
    <>
      <nav className="workspace-tabs" aria-label="Repository views">
        {[
          ...(guidedSessionId === undefined
            ? []
            : [{ id: 'guided', label: 'Guided demo', Icon: GitBranch }]),
          { id: 'runs', label: 'Runs', Icon: GitCompareArrows },
          { id: 'graph', label: 'Evidence trail', Icon: Network },
          { id: 'history', label: 'Source history', Icon: GitBranch },
        ].map(({ id, label, Icon }) => (
          <button
            type="button"
            key={id}
            className={view === id ? 'selected' : ''}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setView(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
        {(guidedRun.refreshing || guidedRun.refreshError) && (
          <span className="live-updating" role="status">
            {guidedRun.refreshError
              ? 'Could not update; showing the last loaded state'
              : 'Updating…'}
          </span>
        )}
        {repo.site && (
          <div className="tab-site">
            <SiteLink repo={repo.id} publishedCommit={repo.site.commit} />
          </div>
        )}
      </nav>
      {repo.pending && (
        <div className="publication-banner" role="status">
          Selection recorded. Publication is{' '}
          {repo.status === 'blocked' ? 'blocked by a remote conflict' : 'awaiting Git verification'}
          . Selected <code>{short(repo.head_commit)}</code> · Published{' '}
          <code>{short(repo.published_commit)}</code>
        </div>
      )}
      {(repo.status === 'blocked' || view === 'history') && (
        <ConflictStatusPanel
          repository={repo}
          reviewer={reviewer}
          onChange={onChange}
          onError={onError}
        />
      )}
      {view === 'guided' && guideSession !== undefined && onGuidedSession && (
        <GuidedWorkspace
          snapshot={snapshot}
          sessionId={guideSession}
          onSession={onGuidedSession}
          onState={setGuideState}
          onInspect={inspectGuideRun}
          onProviders={() => onPanel('agents')}
          onRefreshSnapshot={onChange}
        />
      )}
      {/* The Runs toolbar carries its own back link beside its actions. */}
      {guideSession !== undefined && !['guided', 'runs'].includes(view) && (
        <p className="guided-reference">
          <button
            type="button"
            className="text-button guided-back"
            onClick={() => setView('guided')}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Back to guided demo
          </button>
        </p>
      )}
      {/* Only the first read of a selected run replaces its view; live updates keep it rendered. */}
      {view === 'runs' && guidedRun.loading && (
        <p className="workspace-inline-status" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          Loading this run’s current source and checks…
        </p>
      )}
      {view === 'runs' && guidedRun.error && (
        <p className="workspace-inline-status" role="alert">
          {guidedRun.error}
        </p>
      )}
      {view === 'runs' && !guidedRun.loading && !guidedRun.error && (
        <Exploration
          reviewer={reviewer}
          snapshot={visible}
          focusedRunId={guidedRunId || undefined}
          onGuidedDemo={onGuidedDemo}
          onGuidedContinue={guideSession === undefined ? undefined : () => setView('guided')}
          onChange={onChange}
          onError={onError}
          onProviders={(refresh) => (onProviders ? onProviders(refresh) : onPanel('providers'))}
          onAgents={() => onPanel('agents')}
          onSelectedRun={setEvidenceRun}
          initialRunId={evidenceRun || initialRunId}
          requestedRunError={requestedRunError}
          onContext={(id) => {
            setEvidenceRun(id);
            setView('graph');
          }}
        />
      )}
      {view === 'graph' && <GraphWorkspace snapshot={visible} runId={evidenceRun || undefined} />}
      {view === 'history' && (
        <>
          <HistoryTools
            reviewer={reviewer}
            snapshot={visible}
            onGraph={setHistory}
            onError={onError}
          />
          {history && (
            <GraphWorkspace snapshot={visible} initialGraph={history} title="Revision context" />
          )}
        </>
      )}
    </>
  );
}
