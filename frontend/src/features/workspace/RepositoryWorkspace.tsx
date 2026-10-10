import { GitBranch, GitCompareArrows, Network } from 'lucide-react';
import { useState } from 'react';
import { short } from '../../lib/api';
import type { Graph, Snapshot } from '../../lib/types';
import { Exploration } from '../exploration/Exploration';
import { SiteLink } from '../exploration/SiteLink';
import { GraphWorkspace } from '../graph/GraphWorkspace';
import { HistoryTools } from '../history/HistoryTools';
import type { WorkspacePanel } from './WorkspacePanels';

export function RepositoryWorkspace({
  reviewer = false,
  snapshot,
  onChange,
  onError,
  onPanel,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onPanel: (panel: WorkspacePanel) => void;
}) {
  const [view, setView] = useState('runs');
  const [evidenceRun, setEvidenceRun] = useState('');
  const [history, setHistory] = useState<Graph | null>(null);
  const repo = snapshot.repository;
  return (
    <>
      <nav className="workspace-tabs" aria-label="Repository views">
        {[
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
      {view === 'runs' && (
        <Exploration
          reviewer={reviewer}
          snapshot={snapshot}
          onChange={onChange}
          onError={onError}
          onProviders={() => onPanel('providers')}
          onAgents={() => onPanel('agents')}
          onSelectedRun={setEvidenceRun}
          initialRunId={evidenceRun}
          onContext={(id) => {
            setEvidenceRun(id);
            setView('graph');
          }}
        />
      )}
      {view === 'graph' && <GraphWorkspace snapshot={snapshot} runId={evidenceRun || undefined} />}
      {view === 'history' && (
        <>
          <HistoryTools
            reviewer={reviewer}
            snapshot={snapshot}
            onGraph={setHistory}
            onError={onError}
          />
          {history && (
            <GraphWorkspace snapshot={snapshot} initialGraph={history} title="Revision context" />
          )}
        </>
      )}
    </>
  );
}
