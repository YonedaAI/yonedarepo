import type { Graph, RunGraphPage } from '../../lib/types';

export function mergeRunGraphPage(before: Graph, page: RunGraphPage): Graph {
  const nodes = new Map(before.nodes.map((node) => [node.id, node]));
  for (const node of page.nodes)
    nodes.set(String(node.id), node as unknown as Graph['nodes'][number]);
  const edges = new Map(
    before.edges.map((edge) => [`${edge.source}:${edge.target}:${edge.relation}`, edge]),
  );
  for (const item of page.edges) {
    const edge = item as unknown as Graph['edges'][number];
    edges.set(`${edge.source}:${edge.target}:${edge.relation}`, edge);
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: page.has_more,
  };
}
