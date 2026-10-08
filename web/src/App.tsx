import { ExternalLink, GitBranch, History, KeyRound, Network, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Exploration } from './features/exploration/Exploration';
import { ContextGraph } from './features/graph/ContextGraph';
import { EvidencePanel } from './features/graph/EvidencePanel';
import { HistoryTools } from './features/history/HistoryTools';
import { OwnerConnection } from './features/workspace/OwnerConnection';
import { useRepository } from './hooks/useRepository';
import { short } from './lib/api';
import type { Graph, GraphNode } from './lib/types';
export function App() {
  const state = useRepository();
  const [view, setView] = useState<'explore' | 'history'>('explore');
  const [showAuth, setShowAuth] = useState(false);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [node, setNode] = useState<GraphNode | null>(null);
  const snapshot = state.snapshot;
  useEffect(() => {
    if (!state.authenticated) {
      setGraph(null);
      setNode(null);
    }
  }, [state.authenticated]);
  const activeGraph = graph ?? { nodes: snapshot?.nodes ?? [], edges: snapshot?.edges ?? [] };
  return (
    <div className="app">
      <aside className="rail">
        <a className="brand" href="/">
          <span className="brand-glyph">y</span>
          <span>
            YonedaRepo<small>Context for what comes next.</small>
          </span>
        </a>
        <div className="repository-list">
          <p>Repositories</p>
          {state.repositories.map((repo) => (
            <button
              type="button"
              className={repo.id === state.id ? 'active' : ''}
              key={repo.id}
              onClick={() => {
                state.setId(repo.id);
                setGraph(null);
                setNode(null);
              }}
            >
              <GitBranch size={17} />
              {repo.name}
            </button>
          ))}
          {!state.repositories.length && (
            <span className="rail-empty">
              {state.loading
                ? 'Loading workspace…'
                : state.authenticated
                  ? 'No repositories added yet'
                  : 'Sign in to see your repositories'}
            </span>
          )}
        </div>
        <div className="rail-bottom">
          <span className="environment">
            <i />
            Development workspace
          </span>
          <button type="button" onClick={() => setShowAuth(!showAuth)}>
            <KeyRound size={16} />
            Owner connection
          </button>
          <a href="https://github.com/cloudflare/artifacts" target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Built on Cloudflare
          </a>
        </div>
      </aside>
      <main>
        <header className="workspace-header">
          <div>
            <GitBranch size={18} />
            <span>{snapshot?.repository.name ?? 'Workspace'}</span>
          </div>
          <div className="header-actions">
            {snapshot && (
              <>
                <span>
                  Published <code>{short(snapshot.repository.published_commit)}</code>
                </span>
                <span className="version">v{snapshot.repository.version}</span>
              </>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={() => {
                void state.discover();
                void state.refresh();
              }}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        {showAuth && (
          <OwnerConnection
            authenticated={state.authenticated}
            onConnected={() => {
              setShowAuth(false);
              void state.discover();
            }}
            onDisconnect={state.clear}
            onError={state.setError}
          />
        )}
        {state.error && (
          <div role="alert" className="error-banner">
            {state.error}
            <button type="button" className="quiet" onClick={() => setShowAuth(true)}>
              Check connection
            </button>
          </div>
        )}
        {snapshot ? (
          <>
            <nav className="workspace-tabs" aria-label="Repository views">
              <button
                type="button"
                className={view === 'explore' ? 'selected' : ''}
                onClick={() => setView('explore')}
              >
                <Network size={17} />
                Exploration
              </button>
              <button
                type="button"
                className={view === 'history' ? 'selected' : ''}
                onClick={() => setView('history')}
              >
                <History size={17} />
                Intentional history
              </button>
              <span>{snapshot.seq} recorded events</span>
            </nav>
            {snapshot.repository.pending && (
              <div className="publication-banner">
                Decision selected. Canonical publication is{' '}
                {snapshot.repository.status === 'blocked'
                  ? 'blocked by a remote conflict'
                  : 'awaiting verification'}
                . Selected <code>{short(snapshot.repository.head_commit)}</code>; published{' '}
                <code>{short(snapshot.repository.published_commit)}</code>.
              </div>
            )}
            {view === 'explore' ? (
              <Exploration snapshot={snapshot} onChange={state.refresh} onError={state.setError} />
            ) : (
              <HistoryTools snapshot={snapshot} onGraph={setGraph} onError={state.setError} />
            )}
            <section className="graph-section">
              <div className="graph-heading">
                <h2>Context graph</h2>
                <p>
                  {graph ? 'Source history' : 'Intent, evidence and alternatives'}
                  <button type="button" className="quiet" onClick={() => setGraph(null)}>
                    Show all
                  </button>
                </p>
              </div>
              <div className="graph-workspace">
                <div className="graph-canvas">
                  <ContextGraph graph={activeGraph} onSelect={setNode} />
                </div>
                {node && (
                  <EvidencePanel repo={state.id} node={node} onClose={() => setNode(null)} />
                )}
              </div>
              <footer>
                Agent-authored context records assertions. Verification and human decisions are
                recorded separately.
              </footer>
            </section>
          </>
        ) : (
          <section className="welcome">
            <span className="welcome-graph">
              <GitBranch size={64} strokeWidth={1} />
              <Network size={42} strokeWidth={1} />
            </span>
            <h1>
              Code remembers what changed.
              <br />
              Give it the context to remember why.
            </h1>
            <p>
              {state.loading
                ? 'Loading your workspace…'
                : state.authenticated
                  ? state.id
                    ? 'Loading repository…'
                    : 'Your workspace is connected. Add a repository to begin.'
                  : 'Sign in to open your repositories. Describe a change, and agents research the code, build alternatives and record the context behind them.'}
            </p>
            {!state.authenticated && !state.loading && (
              <button type="button" onClick={() => setShowAuth(true)}>
                <KeyRound size={16} />
                Connect workspace
              </button>
            )}
            {state.authenticated && !state.id && (
              <p className="setup-hint">
                For the development fixture, run{' '}
                <code>cargo xtask seed-demo --url {location.origin}</code>, then refresh.
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
