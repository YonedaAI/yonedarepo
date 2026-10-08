import { GitBranch, History, Network, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Exploration } from './features/exploration/Exploration';
import { SiteLink } from './features/exploration/SiteLink';
import { ContextGraph } from './features/graph/ContextGraph';
import { EvidencePanel } from './features/graph/EvidencePanel';
import { GraphTools } from './features/graph/GraphTools';
import { HistoryTools } from './features/history/HistoryTools';
import { AccountPanel } from './features/workspace/AccountPanel';
import { AgentConnections } from './features/workspace/AgentConnections';
import { NewProject } from './features/workspace/NewProject';
import { ProviderSettings } from './features/workspace/ProviderSettings';
import { WorkspaceRail } from './features/workspace/WorkspaceRail';
import { api } from './lib/api';
import './styles/onboarding.css';
import { DemoGuide } from './features/workspace/DemoGuide';
import { OwnerConnection } from './features/workspace/OwnerConnection';
import './styles/demo-guide.css';
import { useRepository } from './hooks/useRepository';
import { short } from './lib/api';
import type { Graph, GraphNode } from './lib/types';
export function App() {
  const state = useRepository();
  const [view, setView] = useState<'explore' | 'history'>('explore');
  const [showAgents, setShowAgents] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
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
  const selectedNode = node
    ? (snapshot?.nodes.find((current) => current.id === node.id) ??
      activeGraph.nodes.find((current) => current.id === node.id))
    : null;
  return (
    <div className="app">
      <WorkspaceRail
        state={state}
        showGuide={showGuide}
        onAgents={() => setShowAgents(!showAgents)}
        onProject={() => setShowProject(true)}
        onSettings={() => setShowSettings(!showSettings)}
        onAuth={() => setShowAuth(!showAuth)}
        onGuide={() => setShowGuide(!showGuide)}
        onRepository={() => {
          setGraph(null);
          setNode(null);
        }}
      />
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
        {showAgents && snapshot && (
          <AgentConnections key={state.id} repo={state.id} onClose={() => setShowAgents(false)} />
        )}
        {showSettings && state.authenticated && (
          <ProviderSettings onClose={() => setShowSettings(false)} />
        )}
        {showProject && state.authenticated && (
          <NewProject
            onClose={() => setShowProject(false)}
            onCreated={async (id) => {
              await state.discover();
              state.setId(id);
              setShowProject(false);
            }}
          />
        )}
        {showGuide && <DemoGuide onClose={() => setShowGuide(false)} />}
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
            {snapshot.repository.site && (
              <div className="publication-banner">
                <SiteLink repo={state.id} publishedCommit={snapshot.repository.site.commit} />
              </div>
            )}
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
              <Exploration
                key={snapshot.repository.id}
                snapshot={snapshot}
                onChange={state.refresh}
                onError={state.setError}
              />
            ) : (
              <HistoryTools
                key={snapshot.repository.id}
                snapshot={snapshot}
                onGraph={setGraph}
                onError={state.setError}
              />
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
              <GraphTools
                repo={state.id}
                selected={selectedNode}
                onGraph={setGraph}
                onSelect={setNode}
              />
              <div className="graph-workspace">
                <div className="graph-canvas">
                  <ContextGraph graph={activeGraph} onSelect={setNode} />
                </div>
                {selectedNode && (
                  <EvidencePanel
                    repo={state.id}
                    node={selectedNode}
                    onClose={() => setNode(null)}
                  />
                )}
              </div>
              <footer>
                Agent-authored context records assertions. Verification and human decisions are
                recorded separately.
              </footer>
            </section>
          </>
        ) : !state.authenticated && !state.loading ? (
          <section className="welcome-onboarding">
            <div>
              <span className="welcome-graph">
                <GitBranch size={64} strokeWidth={1} />
                <Network size={42} strokeWidth={1} />
              </span>
              <h1>
                Build together.
                <br />
                Keep the why.
              </h1>
              <p>
                Give concurrent agents one shared intent. Compare their code, inspect the context
                behind it, and choose what ships. Future agents pick up where you left off.
              </p>
            </div>
            <AccountPanel
              onConnected={() => {
                void state.discover();
              }}
            />
          </section>
        ) : (
          <section className="welcome">
            <h1>
              {state.loading
                ? 'Opening your workspace…'
                : state.project
                  ? state.project.name
                  : 'Your next project starts here.'}
            </h1>
            <p>
              {state.project?.status === 'failed'
                ? state.project.error
                : state.project?.status === 'provisioning'
                  ? 'Provisioning your repository in Cloudflare Artifacts. This page checks for progress automatically.'
                  : state.id
                    ? 'Loading repository…'
                    : 'Add a repository, connect your agent providers, then describe what you want to build.'}
            </p>
            {state.project?.status === 'failed' && (
              <button
                type="button"
                onClick={async () => {
                  await api(`projects/${state.id}/retry`, {});
                  await state.discover();
                }}
              >
                Retry provisioning
              </button>
            )}
            {!state.id && state.authenticated && (
              <div className="run-actions">
                <button type="button" onClick={() => setShowProject(true)}>
                  Add repository
                </button>
                <button type="button" className="quiet" onClick={() => setShowSettings(true)}>
                  Connect providers
                </button>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
