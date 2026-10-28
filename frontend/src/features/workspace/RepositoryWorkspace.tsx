import { GitCompareArrows, Network } from 'lucide-react';
import { useState } from 'react';
import { short } from '../../lib/api';
import type { Graph, Snapshot } from '../../lib/types';
import { Exploration } from '../exploration/Exploration';
import { SiteLink } from '../exploration/SiteLink';
import { GraphWorkspace } from '../graph/GraphWorkspace';
import { ConflictStatusPanel } from '../history/ConflictStatusPanel';
import { HistoryTools } from '../history/HistoryTools';
import type { WorkspacePanel } from './WorkspacePanels';

/** The Runs tab of a repository with an agent project: runs, and the evidence trail. */
export function RepositoryWorkspace({
  reviewer = false,
  snapshot,
  initialRunId = '',
  requestedRunError = '',
  onChange,
  onError,
  onPanel,
  onProviders,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  initialRunId?: string;
  requestedRunError?: string;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onPanel: (panel: WorkspacePanel) => void;
  onProviders?: (refresh?: () => void) => void;
}) {
  const [view, setView] = useState('runs');
  const [evidenceRun, setEvidenceRun] = useState('');
  const repo = snapshot.repository;
  return (
    <>
      <nav className="workspace-tabs" aria-label="Runs views">
        {[
          { id: 'runs', label: 'Runs', Icon: GitCompareArrows },
          { id: 'graph', label: 'Evidence trail', Icon: Network },
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
      {repo.status === 'blocked' && (
        <ConflictStatusPanel
          repository={repo}
          reviewer={reviewer}
          onChange={onChange}
          onError={onError}
        />
      )}
      {view === 'runs' && (
        <Exploration
          reviewer={reviewer}
          snapshot={snapshot}
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
      {view === 'graph' && <GraphWorkspace snapshot={snapshot} runId={evidenceRun || undefined} />}
    </>
  );
}

/** The agent project's source history (History tab): conflicts, traces and their graph. */
export function AgentSourceHistory({
  reviewer = false,
  snapshot,
  onChange,
  onError,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [history, setHistory] = useState<Graph | null>(null);
  return (
    <div className="agent-source-history">
      <ConflictStatusPanel
        repository={snapshot.repository}
        reviewer={reviewer}
        onChange={onChange}
        onError={onError}
      />
      <HistoryTools
        reviewer={reviewer}
        snapshot={snapshot}
        onGraph={setHistory}
        onError={onError}
      />
      {history && (
        <GraphWorkspace snapshot={snapshot} initialGraph={history} title="Revision context" />
      )}
    </div>
  );
}
