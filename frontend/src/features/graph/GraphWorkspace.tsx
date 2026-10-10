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
  const [graphError, setGraphError] = useState('');
  const [graphCursor, setGraphCursor] = useState<string | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
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
  useEffect(() => {
    if (initialGraph || !snapshot.graph_paged || !activeRun?.id) return;
    let current = true;
    setLoadedRunGraph({ nodes: [], edges: [] });
    setGraphError('');
    setGraphCursor(null);
    setLoadingGraph(true);
    const query = new URLSearchParams({ run_id: activeRun.id, limit: '200' });
    void api<RunGraphPage>(`repos/${snapshot.repository.id}/run_graph_page?${query}`)
      .then((page) => {
        if (current) {
          setLoadedRunGraph(mergeRunGraphPage({ nodes: [], edges: [] }, page));
          setGraphCursor(page.has_more ? page.next_cursor : null);
        }
      })
      .catch((error: unknown) => {
        if (current) setGraphError((error as Error).message);
      })
      .finally(() => {
        if (current) setLoadingGraph(false);
      });
    return () => {
      current = false;
    };
  }, [initialGraph, snapshot.graph_paged, snapshot.repository.id, activeRun?.id]);
  async function loadMoreRunGraph() {
    if (!activeRun?.id || !graphCursor || loadingGraph) return;
    setLoadingGraph(true);
    setGraphError('');
    const query = new URLSearchParams({ run_id: activeRun.id, limit: '200', cursor: graphCursor });
    try {
      const page = await api<RunGraphPage>(
        `repos/${snapshot.repository.id}/run_graph_page?${query}`,
      );
      setLoadedRunGraph((before) => mergeRunGraphPage(before, page));
      setGraphCursor(page.has_more ? page.next_cursor : null);
    } catch (error) {
      setGraphError((error as Error).message);
    } finally {
      setLoadingGraph(false);
    }
  }
  const graphSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, ...loadedRunGraph.nodes],
    edges: [...snapshot.edges, ...loadedRunGraph.edges],
  };
  const scoped = runEvidenceGraph(graphSnapshot, activeRun?.id ?? '');
  const neighborhood = initialNeighborhood(chosenRun || runId ? scoped : (initialGraph ?? scoped));
  const active =
    customGraph ?? (full ? { nodes: snapshot.nodes, edges: snapshot.edges } : neighborhood);
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
                  ? 'Full repository graph'
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
