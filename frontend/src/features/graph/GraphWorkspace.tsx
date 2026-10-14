import { useEffect, useState } from 'react';
import type { Graph, GraphNode, Snapshot } from '../../lib/types';
import { ContextGraph } from './ContextGraph';
import { EvidencePanel } from './EvidencePanel';
import { EvidenceTrail } from './EvidenceTrail';
import { focusedNeighborhood, initialNeighborhood, runEvidenceGraph } from './evidenceView';
import { GraphTools } from './GraphTools';
import { useRunGraphPages } from './useRunGraphPages';

export function GraphWorkspace({
  snapshot,
  initialGraph = null,
  title = 'Evidence trail',
  runId,
}: {
  snapshot: Snapshot;
  initialGraph?: Graph | null;
  title?: string;
  runId?: string;
}) {
  const [view, setView] = useState('trail');
  const [chosenRun, setChosenRun] = useState('');
  const [customGraph, setCustomGraph] = useState<Graph | null>(null);
  const [full, setFull] = useState(false);
  const [nodeId, setNodeId] = useState('');
  // The run shown by default, kept so a run created during a live update does not switch the
  // view and discard its loaded graph.
  const [defaultRun] = useState({ id: '' });
  useEffect(() => {
    if (!initialGraph) return;
    setCustomGraph(null);
    setFull(false);
    setNodeId('');
  }, [initialGraph]);
  const latest = [...snapshot.runs].sort((a, b) => a.created_at - b.created_at).at(-1);
  const historyRun = [...snapshot.runs]
    .sort((a, b) => b.created_at - a.created_at)
    .find((run) => initialGraph?.nodes.some((node) => node.id === run.id));
  const activeRun =
    snapshot.runs.find(
      (run) => run.id === (chosenRun || runId || (initialGraph ? '' : defaultRun.id)),
    ) ??
    historyRun ??
    latest;
  if (!initialGraph && !defaultRun.id && activeRun?.id) defaultRun.id = activeRun.id;
  const {
    graph: loadedRunGraph,
    runId: loadedGraphRunId,
    error: graphError,
    cursor: graphCursor,
    loading: loadingGraph,
    loadMore: loadMoreRunGraph,
  } = useRunGraphPages(
    snapshot.repository.id,
    !initialGraph && snapshot.graph_paged ? activeRun?.id : undefined,
  );
  const runGraphPaged = Boolean(snapshot.graph_paged && !initialGraph);
  const activeLoadedGraph =
    loadedGraphRunId === activeRun?.id ? loadedRunGraph : { nodes: [], edges: [] };
  const graphSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, ...activeLoadedGraph.nodes],
    edges: [...snapshot.edges, ...activeLoadedGraph.edges],
  };
  const scoped = runEvidenceGraph(graphSnapshot, activeRun?.id ?? '');
  const neighborhood = initialNeighborhood(chosenRun || runId ? scoped : (initialGraph ?? scoped));
  const active =
    customGraph ??
    (full
      ? runGraphPaged
        ? activeLoadedGraph
        : { nodes: snapshot.nodes, edges: snapshot.edges }
      : neighborhood);
  const selected =
    active.nodes.find((node) => node.id === nodeId) ??
    snapshot.nodes.find((node) => node.id === nodeId);
  const displayed = nodeId ? focusedNeighborhood(active, nodeId) : active;
  function select(node: GraphNode) {
    setNodeId(node.id);
  }
  return (
    <section className="graph-section">
      <div className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>Follow the intent, captured source, independent checks and recorded decision.</p>
        </div>
      </div>
      {snapshot.runs.length > 0 && (
        <label className="evidence-run-picker">
          Evidence for run
          <select
            value={activeRun?.id ?? ''}
            onChange={(event) => {
              setChosenRun(event.target.value);
              setCustomGraph(null);
              setFull(false);
              setNodeId('');
            }}
          >
            {[...snapshot.runs].reverse().map((run) => (
              <option key={run.id} value={run.id}>
                {run.intent?.slice(0, 90) || run.id} · {run.status}
              </option>
            ))}
          </select>
        </label>
      )}
      <nav className="evidence-view-switch" aria-label="Evidence presentation">
        <button
          type="button"
          className={view === 'trail' ? '' : 'quiet'}
          aria-pressed={view === 'trail'}
          onClick={() => setView('trail')}
        >
          Evidence trail
        </button>
        <button
          type="button"
          className={view === 'graph' ? '' : 'quiet'}
          aria-pressed={view === 'graph'}
          onClick={() => setView('graph')}
        >
          Explore graph
        </button>
      </nav>
      {view === 'trail' ? (
        <>
          <div className="trail-workspace">
            <EvidenceTrail
              snapshot={graphSnapshot}
              runId={activeRun?.id ?? ''}
              graph={scoped}
              onSelect={select}
            />
            {selected && (
              <EvidencePanel
                repo={snapshot.repository.id}
                node={selected}
                onClose={() => setNodeId('')}
              />
            )}
          </div>
          {snapshot.graph_paged && !initialGraph && (
            <button
              type="button"
              className="quiet"
              disabled={loadingGraph}
              onClick={() => void loadMoreRunGraph()}
            >
              {loadingGraph
                ? 'Loading run context…'
                : graphCursor
                  ? 'Load more run context'
                  : 'Run context loaded'}
            </button>
          )}
        </>
      ) : (
        <>
          <GraphTools
            repo={snapshot.repository.id}
            selected={selected}
            fullGraphLabel={runGraphPaged ? 'Show loaded run graph' : 'Show full graph'}
            onGraph={(graph) => {
              setCustomGraph(graph);
              setNodeId('');
              if (!graph) setFull(true);
            }}
            onSelect={select}
          />
          <div className="graph-scope">
            <p>
              {nodeId
                ? 'Selected record and immediate relationships'
                : full
                  ? runGraphPaged
                    ? 'Loaded run graph'
                    : 'Full repository graph'
                  : customGraph
                    ? 'Search or expanded context'
                    : 'Initial run neighborhood'}{' '}
              · {displayed.nodes.length} records
              {displayed.truncated ? ' · more records available' : ''}
              {' · Drag to pan; use +/− to zoom.'}
            </p>
            {(full || customGraph || nodeId) && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFull(false);
                  setCustomGraph(null);
                  setNodeId('');
                }}
              >
                Return to run neighborhood
              </button>
            )}
          </div>
          {runGraphPaged && (graphCursor || loadingGraph) && (
            <button
              type="button"
              className="quiet"
              disabled={loadingGraph}
              onClick={() => void loadMoreRunGraph()}
            >
              {loadingGraph ? 'Loading run graph…' : 'Load more run graph'}
            </button>
          )}
          <div className="graph-workspace">
            <div className="graph-canvas">
              <ContextGraph
                // Remount (and refit) only when the user changes scope; records arriving from a
                // live update are added in place, keeping pan and zoom.
                key={[
                  activeRun?.id,
                  nodeId,
                  full,
                  customGraph?.nodes.map((node) => node.id).join('|'),
                ].join(':')}
                graph={displayed}
                selectedId={nodeId}
                onSelect={select}
              />
            </div>
            {selected && (
              <EvidencePanel
                repo={snapshot.repository.id}
                node={selected}
                onClose={() => setNodeId('')}
              />
            )}
          </div>
        </>
      )}
      {graphError && <p role="alert">Run evidence could not be loaded: {graphError}</p>}
      <footer>
        Agent context contains assertions. Trusted capture, independent checks, owner decisions and
        publication are recorded separately.
      </footer>
    </section>
  );
}
