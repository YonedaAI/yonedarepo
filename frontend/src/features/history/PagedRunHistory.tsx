import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { CandidateDiffPage, Graph, RunDetail, RunGraphPage, RunsPage } from '../../lib/types';

export function PagedRunHistory({
  repo,
  onGraph,
}: {
  repo: string;
  onGraph: (graph: Graph) => void;
}) {
  const [items, setItems] = useState<Record<string, any>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [watermark, setWatermark] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<RunDetail | null>(null);
  const [diffs, setDiffs] = useState<
    Record<string, { text: string; cursor: string | null; more: boolean; watermark: string }>
  >({});
  const [graphCursor, setGraphCursor] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadPage = useCallback(
    async (next: string | null, append: boolean) => {
      append ? setMore(true) : setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams({ limit: '25' });
        if (next) query.set('cursor', next);
        const page = await api<RunsPage>(`repos/${repo}/runs?${query}`);
        setItems((old) => (append ? [...old, ...page.items] : page.items));
        setCursor(page.has_more && page.next_cursor ? page.next_cursor : null);
        setWatermark(page.watermark);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
        setMore(false);
      }
    },
    [repo],
  );
  useEffect(() => {
    void loadPage(null, false);
  }, [loadPage]);

  async function openRun(id: string) {
    setBusy(id);
    setError('');
    try {
      setSelected(await api<RunDetail>(`repos/${repo}/runs/${encodeURIComponent(id)}`));
      setDiffs({});
      setGraph({ nodes: [], edges: [] });
      setGraphCursor(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function loadDiff(candidate: string) {
    setBusy(candidate);
    try {
      const current = diffs[candidate];
      const runId = selected?.runs[0]?.id;
      const candidateRecord = selected?.candidates.find((item) => item.id === candidate);
      const digest = current?.watermark ?? candidateRecord?.diff_digest;
      if (!runId || typeof digest !== 'string' || !digest) {
        throw new Error('This captured diff is missing its run or digest identity.');
      }
      const query = new URLSearchParams({
        run_id: runId,
        candidate_id: candidate,
        limit: '100',
        watermark: digest,
      });
      if (current?.cursor) query.set('cursor', current.cursor);
      const response = await api<CandidateDiffPage>(`repos/${repo}/candidate_diff?${query}`);
      if (response.watermark !== digest) {
        setDiffs((old) => {
          const next = { ...old };
          delete next[candidate];
          return next;
        });
        throw new Error(
          'The captured diff changed while paging. Reload this run before continuing.',
        );
      }
      setDiffs((old) => ({
        ...old,
        [candidate]: {
          text: `${old[candidate]?.text ?? ''}${response.diff ?? ''}`,
          cursor: response.next_cursor,
          more: response.has_more,
          watermark: response.watermark,
        },
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function loadGraph(next = false) {
    const runId = selected?.runs[0]?.id;
    if (!runId) return;
    setBusy(`graph:${runId}`);
    try {
      const query = new URLSearchParams({ run_id: runId, limit: '200' });
      const cursor = next ? graphCursor : null;
      if (cursor) query.set('cursor', cursor);
      const page = await api<RunGraphPage>(`repos/${repo}/run_graph_page?${query}`);
      const nodes = new Map(graph.nodes.map((item) => [item.id, item]));
      for (const item of page.nodes)
        nodes.set(String(item.id), item as unknown as Graph['nodes'][number]);
      const edges = new Map(
        graph.edges.map((item) => [`${item.source}:${item.target}:${item.relation}`, item]),
      );
      for (const item of page.edges) {
        const edge = item as unknown as Graph['edges'][number];
        edges.set(`${edge.source}:${edge.target}:${edge.relation}`, edge);
      }
      const nextGraph = {
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        truncated: page.has_more,
      };
      setGraph(nextGraph);
      setGraphCursor(page.has_more && page.next_cursor ? page.next_cursor : null);
      onGraph(nextGraph);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="paged-run-history" aria-labelledby="paged-run-history-title">
      <div className="history-heading">
        <h2 id="paged-run-history-title">Run history</h2>
        <span>Through update {watermark}</span>
      </div>
      {loading && <p role="status">Loading run history…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !items.length && <p className="empty-note">No runs have been recorded yet.</p>}
      <ol>
        {items.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="text-button"
              aria-current={selected?.runs[0]?.id === run.id ? 'true' : undefined}
              disabled={busy === run.id}
              onClick={() => void openRun(run.id)}
            >
              {run.intent || run.id} · {String(run.status || 'unknown').replaceAll('_', ' ')}
            </button>
          </li>
        ))}
      </ol>
      {cursor && (
        <button
          type="button"
          className="quiet"
          disabled={more}
          onClick={() => void loadPage(cursor, true)}
        >
          {more ? 'Loading earlier runs…' : 'Load earlier runs'}
        </button>
      )}
      {selected && (
        <section className="run-history-detail" aria-label="Selected run detail">
          <h3>{selected.runs[0]?.intent || selected.runs[0]?.id}</h3>
          <p>
            {selected.candidates.length} captured results · {selected.evaluations.length} checks ·{' '}
            {selected.executions.length} executions
          </p>
          {selected.candidates.map((candidate) => (
            <details key={candidate.id}>
              <summary>
                {candidate.summary || candidate.id} · {candidate.revision?.commit}
              </summary>
              {!diffs[candidate.id] || diffs[candidate.id].more ? (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy === candidate.id}
                  onClick={() => void loadDiff(candidate.id)}
                >
                  {diffs[candidate.id]?.more ? 'Load next diff page' : 'Load diff'}
                </button>
              ) : null}
              {diffs[candidate.id]?.text && (
                <pre className="source-diff-history">{diffs[candidate.id].text}</pre>
              )}
            </details>
          ))}
          <button
            type="button"
            className="text-button"
            disabled={busy === `graph:${selected.runs[0]?.id}`}
            onClick={() => void loadGraph(!!graphCursor)}
          >
            {graphCursor ? 'Load more run context' : 'Load run context graph'}
          </button>
        </section>
      )}
    </section>
  );
}
