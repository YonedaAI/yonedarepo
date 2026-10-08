export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  author: string;
  recorded_at: number;
  data: Record<string, any>;
}
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  evidence: string;
}
export interface Repository {
  id: string;
  name: string;
  version: number;
  head_commit: string;
  published_commit: string;
  status: string;
  pending: string | null;
  remote: { namespace: string; name: string };
}
export interface Snapshot {
  repository: Repository;
  runs: Record<string, any>[];
  executions: Record<string, any>[];
  candidates: Record<string, any>[];
  evaluations: Record<string, any>[];
  decisions: Record<string, any>[];
  artifacts: Record<string, any>[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  seq: number;
}
export interface Graph {
  coverage?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
