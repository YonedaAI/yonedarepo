import { useEffect, useState } from 'react';
import type { Graph, GraphNode, Snapshot } from '../../lib/types';
import { ContextGraph } from './ContextGraph';
import { EvidencePanel } from './EvidencePanel';
import { EvidenceTrail } from './EvidenceTrail';
import { initialNeighborhood, runEvidenceGraph } from './evidenceView';
import { GraphTools } from './GraphTools';

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
  const scoped = runEvidenceGraph(snapshot, activeRun?.id ?? '');
  const neighborhood = initialNeighborhood(chosenRun || runId ? scoped : (initialGraph ?? scoped));
  const active =
    customGraph ?? (full ? { nodes: snapshot.nodes, edges: snapshot.edges } : neighborhood);
  const selected =
    active.nodes.find((node) => node.id === nodeId) ??
    snapshot.nodes.find((node) => node.id === nodeId);
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
        <div className="trail-workspace">
          <EvidenceTrail
            snapshot={snapshot}
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
      ) : (
        <>
          <GraphTools
            repo={snapshot.repository.id}
            selected={selected}
            onGraph={(graph) => {
              setCustomGraph(graph);
              if (!graph) setFull(true);
            }}
            onSelect={select}
          />
          <div className="graph-scope">
            <p>
              {full
                ? 'Full repository graph'
                : customGraph
                  ? 'Search or expanded context'
                  : 'Initial run neighborhood'}{' '}
              · {active.nodes.length} records{active.truncated ? ' · more records available' : ''}
            </p>
            {(full || customGraph) && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFull(false);
                  setCustomGraph(null);
                }}
              >
                Return to run neighborhood
              </button>
            )}
          </div>
          <div className="graph-workspace">
            <div className="graph-canvas">
              <ContextGraph graph={active} selectedId={nodeId} onSelect={select} />
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
      <footer>
        Agent context contains assertions. Trusted capture, independent checks, owner decisions and
        publication are recorded separately.
      </footer>
    </section>
  );
}
