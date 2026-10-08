import { useEffect, useState } from 'react';
import type { Graph, GraphNode, Snapshot } from '../../lib/types';
import { ContextGraph } from './ContextGraph';
import { EvidencePanel } from './EvidencePanel';
import { GraphTools } from './GraphTools';

export function GraphWorkspace({
  snapshot,
  initialGraph = null,
  title = 'Context graph',
}: {
  snapshot: Snapshot;
  initialGraph?: Graph | null;
  title?: string;
}) {
  const [graph, setGraph] = useState<Graph | null>(initialGraph);
  const [node, setNode] = useState<GraphNode | null>(null);
  useEffect(() => {
    setGraph(initialGraph);
    setNode(null);
  }, [initialGraph]);
  const active = graph ?? { nodes: snapshot.nodes, edges: snapshot.edges };
  const selected = node
    ? (active.nodes.find((n) => n.id === node.id) ??
      snapshot.nodes.find((n) => n.id === node.id) ??
      null)
    : null;
  return (
    <section className="graph-section">
      <div className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>Follow the intent, evidence and decisions behind your source.</p>
        </div>
        <span className="subtle">{active.nodes.length} records</span>
      </div>
      <GraphTools
        repo={snapshot.repository.id}
        selected={selected}
        onGraph={setGraph}
        onSelect={setNode}
      />
      {(active.nodes.length > 0 || graph === null) && (
        <div className="graph-workspace">
          <div className="graph-canvas">
            <ContextGraph graph={active} onSelect={setNode} />
          </div>
          {selected && (
            <EvidencePanel
              repo={snapshot.repository.id}
              node={selected}
              onClose={() => setNode(null)}
            />
          )}
        </div>
      )}
      <footer>
        Agent context contains assertions. Independent checks and owner decisions are recorded
        separately.
      </footer>
    </section>
  );
}
