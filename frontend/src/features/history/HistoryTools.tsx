import { Activity, Search } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, RunGraphPage, Snapshot } from '../../lib/types';
import { PagedRunHistory } from './PagedRunHistory';
export function HistoryTools({
  reviewer = false,
  snapshot,
  onGraph,
  onError,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  onGraph: (graph: Graph) => void;
  onError: (message: string) => void;
}) {
  const [path, setPath] = useState(
    snapshot.repository.policy?.build?.static_dir
      ? `${snapshot.repository.policy.build.static_dir}/index.html`
      : 'src/main.rs',
  );
  const [commit, setCommit] = useState(snapshot.repository.published_commit);
  const [assumption, setAssumption] = useState('');
  const [value, setValue] = useState(350);
  const [message, setMessage] = useState('');
  const [provenance, setProvenance] = useState<any | null>(null);
  const [contextCursor, setContextCursor] = useState<string | null>(null);
  const [contextGraph, setContextGraph] = useState<Graph>({ nodes: [], edges: [] });
  const assumptions = snapshot.nodes.filter(
    (n) =>
      n.kind === 'assumption' &&
      typeof n.data.limit === 'number' &&
      typeof n.data.metric === 'string',
  );
  const current = assumptions.find((n) => n.id === assumption) ?? assumptions[0];
  async function why() {
    try {
      const graph = await api<Graph>(
        `repos/${snapshot.repository.id}/why?${new URLSearchParams({ commit, path })}`,
      );
      setProvenance(graph);
      setContextCursor(null);
      setContextGraph({ nodes: [], edges: [] });
      if (graph.nodes?.length) onGraph(graph);
      setMessage(
        graph.coverage === 'unknown' && graph.truncated
          ? 'The bounded receipt scan reached its limit, so lineage is unknown in this view.'
          : graph.coverage === 'unknown'
            ? 'No recorded decision covers this exact revision and path.'
            : graph.truncated
              ? 'Showing a bounded part of the recorded history. Some connected context is outside this view.'
              : 'Showing recorded context for this source revision.',
      );
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function incident() {
    if (!current) return;
    try {
      const result = await api<{ status: string }>(`repos/${snapshot.repository.id}/observe`, {
        id: `incident-${crypto.randomUUID()}`,
        assumption: current.id,
        metric: current.data.metric,
        value,
        simulated: true,
      });
      const graph = await api<Graph>(
        `repos/${snapshot.repository.id}/graph?${new URLSearchParams({ id: current.id, depth: '8' })}`,
      );
      onGraph(graph);
      setMessage(`Simulated observation recorded: ${result.status.replaceAll('_', ' ')}.`);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  async function loadContextGraph(next = false) {
    const runId = provenance?.lineage?.[0]?.run_id;
    if (!runId) return;
    try {
      const query = new URLSearchParams({ run_id: runId, limit: '200' });
      const cursor = next ? contextCursor : null;
      if (cursor) query.set('cursor', cursor);
      const page = await api<RunGraphPage>(
        `repos/${snapshot.repository.id}/run_graph_page?${query}`,
      );
      const nodes = new Map(contextGraph.nodes.map((node) => [node.id, node]));
      for (const item of page.nodes)
        nodes.set(String(item.id), item as unknown as Graph['nodes'][number]);
      const edges = new Map(
        contextGraph.edges.map((edge) => [`${edge.source}:${edge.target}:${edge.relation}`, edge]),
      );
      for (const item of page.edges) {
        const edge = item as unknown as Graph['edges'][number];
        edges.set(`${edge.source}:${edge.target}:${edge.relation}`, edge);
      }
      const graph = {
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        truncated: page.has_more,
      };
      setContextGraph(graph);
      setContextCursor(page.has_more && page.next_cursor ? page.next_cursor : null);
      onGraph(graph);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="history-tools">
      <section>
        <h2>
          <Search size={18} />
          Why is this code here?
        </h2>
        <p>
          Follow recorded evidence from a source revision to its original intent and alternatives.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void why();
          }}
        >
          <label>
            Commit
            <input value={commit} onChange={(e) => setCommit(e.target.value)} required />
          </label>
          <label>
            Path
            <input value={path} onChange={(e) => setPath(e.target.value)} required />
          </label>
          <button type="submit">Trace history</button>
        </form>
      </section>
      {current && !reviewer && (
        <section>
          <h2>
            <Activity size={18} />
            Challenge an assumption
          </h2>
          <p>Record a simulated incident without changing what the agent originally asserted.</p>
          {current ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void incident();
              }}
            >
              <label>
                Recorded assumption
                <select value={current.id} onChange={(e) => setAssumption(e.target.value)}>
                  {assumptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {current.data.metric}
                <input
                  type="number"
                  value={value}
                  onChange={(e) => setValue(Number(e.target.value))}
                  required
                />
              </label>
              <button type="submit">Record simulated observation</button>
            </form>
          ) : (
            <p className="empty-note">Research has not recorded a bounded assumption yet.</p>
          )}
        </section>
      )}
      {message && (
        <p role="status" className="history-message">
          {message}
        </p>
      )}
      {provenance && provenance.coverage === 'recorded' && (
        <section aria-label="File provenance" className="file-provenance">
          <h3>{provenance.status === 'deleted' ? 'Recorded deletion' : 'Recorded file lineage'}</h3>
          <p>
            Trusted capture receipts for <code>{path}</code> at <code>{commit}</code>.
          </p>
          <ol>
            {provenance.lineage.map((receipt: any) => (
              <li key={receipt.id}>
                <strong>{receipt.change}</strong> ·{' '}
                {receipt.capture_kind?.replaceAll('_', ' ') ||
                  receipt.candidate_summary ||
                  receipt.candidate}
                {receipt.old_path && (
                  <>
                    {' '}
                    · renamed from <code>{receipt.old_path}</code>
                  </>
                )}
                {receipt.lineage_relation === 'exact_blob_inherited_by_merge_refresh' && (
                  <span> · Exact bytes inherited by merge refresh</span>
                )}
                <p>
                  {receipt.capture_kind === 'merge_refresh' ? (
                    <>Platform merge refresh, capture lease {receipt.capture_epoch}</>
                  ) : (
                    <>
                      Execution <code>{receipt.execution_id}</code>, attempt{' '}
                      {receipt.execution_epoch}, capture lease {receipt.capture_epoch}
                    </>
                  )}
                  {receipt.source_execution_id && (
                    <>
                      {' '}
                      · Exact blob inherited from execution{' '}
                      <code>{receipt.source_execution_id}</code>, attempt{' '}
                      {receipt.source_execution_epoch}
                    </>
                  )}
                  ; blobs <code>{receipt.old_blob || 'none'}</code> →{' '}
                  <code>{receipt.new_blob || 'deleted'}</code>.
                </p>
              </li>
            ))}
          </ol>
          {provenance.decisions?.map((decision: any) => (
            <p key={decision.id}>Owner decision: {decision.rationale || decision.status}</p>
          ))}
          {!!provenance.rejected_alternatives?.length && (
            <details>
              <summary>Rejected alternatives and reasons</summary>
              <ul>
                {provenance.rejected_alternatives.map((item: any) => (
                  <li key={`${item.decision}:${item.candidate}`}>{item.reason}</li>
                ))}
              </ul>
            </details>
          )}
          {provenance.lineage?.[0]?.run_id && (
            <button
              type="button"
              className="quiet"
              onClick={() => void loadContextGraph(!!contextCursor)}
            >
              {contextCursor
                ? 'Load more intent and assertion context'
                : 'Load intent and assertion context'}
            </button>
          )}
        </section>
      )}
      <PagedRunHistory repo={snapshot.repository.id} onGraph={onGraph} />
    </div>
  );
}
