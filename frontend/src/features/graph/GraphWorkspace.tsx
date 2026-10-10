import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, GraphNode, RunGraphPage, Snapshot } from '../../lib/types';
import { ContextGraph } from './ContextGraph';
import { EvidencePanel } from './EvidencePanel';
import { EvidenceTrail } from './EvidenceTrail';
import { focusedNeighborhood, initialNeighborhood, runEvidenceGraph } from './evidenceView';
import { GraphTools } from './GraphTools';
import { mergeRunGraphPage } from './runGraphPages';

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
  const [loadedRunGraph, setLoadedRunGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [loadedGraphRunId, setLoadedGraphRunId] = useState('');
  const [graphError, setGraphError] = useState('');
  const [graphCursor, setGraphCursor] = useState<string | null>(null);
  const [graphWatermark, setGraphWatermark] = useState<number | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [graphRequest] = useState({ current: { key: '', generation: 0 } });
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
    snapshot.runs.find((run) => run.id === (chosenRun || runId)) ?? historyRun ?? latest;
  const requestKey = `${snapshot.repository.id}:${activeRun?.id ?? ''}:${initialGraph ? 'external' : 'paged'}`;
  if (graphRequest.current.key !== requestKey) {
    graphRequest.current.key = requestKey;
    graphRequest.current.generation += 1;
  }
  useEffect(() => {
    if (initialGraph || !snapshot.graph_paged || !activeRun?.id) return;
    let current = true;
    const generation = graphRequest.current.generation;
    setLoadedRunGraph({ nodes: [], edges: [] });
    setLoadedGraphRunId('');
    setGraphError('');
    setGraphCursor(null);
    setGraphWatermark(null);
    setLoadingGraph(true);
    const query = new URLSearchParams({ run_id: activeRun.id, limit: '200' });
    void api<RunGraphPage>(`repos/${snapshot.repository.id}/run_graph_page?${query}`)
      .then((page) => {
        if (current && graphRequest.current.generation === generation) {
          setLoadedRunGraph(mergeRunGraphPage({ nodes: [], edges: [] }, page));
          setLoadedGraphRunId(activeRun.id);
          setGraphCursor(page.has_more ? page.next_cursor : null);
          setGraphWatermark(page.watermark);
        }
      })
      .catch((error: unknown) => {
        if (current && graphRequest.current.generation === generation)
          setGraphError((error as Error).message);
      })
      .finally(() => {
        if (current && graphRequest.current.generation === generation) setLoadingGraph(false);
      });
    return () => {
      current = false;
    };
  }, [graphRequest, initialGraph, snapshot.graph_paged, snapshot.repository.id, activeRun?.id]);
  async function loadMoreRunGraph() {
    if (
      !activeRun?.id ||
      loadedGraphRunId !== activeRun.id ||
      !graphCursor ||
      graphWatermark === null ||
      loadingGraph
    )
      return;
    const generation = graphRequest.current.generation;
    const requestedRunId = activeRun.id;
    setLoadingGraph(true);
    setGraphError('');
    const query = new URLSearchParams({
      run_id: requestedRunId,
      limit: '200',
      cursor: graphCursor,
      watermark: String(graphWatermark),
    });
    try {
      const page = await api<RunGraphPage>(
        `repos/${snapshot.repository.id}/run_graph_page?${query}`,
      );
      if (graphRequest.current.generation === generation) {
        setLoadedRunGraph((before) => mergeRunGraphPage(before, page));
        setGraphCursor(page.has_more ? page.next_cursor : null);
        setGraphWatermark(page.watermark);
      }
    } catch (error) {
      if (graphRequest.current.generation === generation) setGraphError((error as Error).message);
    } finally {
      if (graphRequest.current.generation === generation) setLoadingGraph(false);
    }
  }
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
                key={displayed.nodes.map((node) => node.id).join('|')}
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
