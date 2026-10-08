import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { useMemo } from 'react';
import '@xyflow/react/dist/style.css';
import type { Graph, GraphNode } from '../../lib/types';

const graphFitOptions = { padding: 0.18, minZoom: 0.02, maxZoom: 0.85 };

const columns = [
  'repository',
  'intent',
  'run',
  'context',
  'requirement',
  'constraint',
  'assumption',
  'finding',
  'alternative',
  'proposed_decision',
  'question',
  'execution',
  'candidate',
  'evaluation',
  'decision',
  'source',
  'observation',
];
export function ContextGraph({
  graph,
  onSelect,
}: {
  graph: Graph;
  onSelect: (node: GraphNode) => void;
}) {
  const { nodes, edges, identity } = useMemo(() => {
    const offsets: Record<string, number> = {};
    const nodes: Node[] = graph.nodes.map((node) => {
      const col = Math.max(0, columns.indexOf(node.kind));
      const row = offsets[node.kind] ?? 0;
      offsets[node.kind] = row + 1;
      return {
        id: node.id,
        position: { x: col * 245, y: row * 118 + (col % 2) * 25 },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        className: `graph-node kind-${node.kind}`,
        data: {
          label: (
            <>
              <span className="node-kind">{node.kind}</span>
              <strong>{node.label}</strong>
            </>
          ),
        },
      };
    });
    const edges: Edge[] = graph.edges.map((edge, index) => ({
      id: `${index}:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      label: edge.relation.replaceAll('_', ' '),
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: edge.relation === 'challenges' ? '#b77817' : '#8da5b6' },
      labelStyle: { fontSize: 10, fill: '#526b7d' },
      labelBgStyle: { fill: '#f0f5f8' },
    }));
    return { nodes, edges, identity: JSON.stringify(graph.nodes.map((node) => node.id)) };
  }, [graph]);
  if (!nodes.length)
    return (
      <div className="graph-empty">
        <span className="branch-symbol">⤷</span>
        <h3>History begins with intent.</h3>
        <p>Start an exploration to connect research, source and decisions.</p>
      </div>
    );
  return (
    <ReactFlow
      key={identity}
      nodes={nodes}
      edges={edges}
      fitView
      minZoom={graphFitOptions.minZoom}
      maxZoom={2}
      fitViewOptions={graphFitOptions}
      nodesDraggable={false}
      onNodeClick={(_, node) => {
        const original = graph.nodes.find((n) => n.id === node.id);
        if (original) onSelect(original);
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="#ccdae2" />
      <Controls showInteractive={false} fitViewOptions={graphFitOptions} />
    </ReactFlow>
  );
}
