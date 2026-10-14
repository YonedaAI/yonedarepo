import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Graph, RunGraphPage } from '../../lib/types';
import { mergeRunGraphPage } from './runGraphPages';

const empty: Graph = { nodes: [], edges: [] };

/**
 * Pages one run's evidence graph. It reloads only when the repository or run changes, never on a
 * live snapshot update, so loaded pages stay rendered while agents work.
 */
export function useRunGraphPages(repo: string, runId: string | undefined) {
  const [graph, setGraph] = useState<Graph>(empty);
  const [loadedRunId, setLoadedRunId] = useState('');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [watermark, setWatermark] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [request] = useState({ current: { key: '', generation: 0 } });
  const requestKey = `${repo}:${runId ?? ''}`;
  if (request.current.key !== requestKey) {
    request.current.key = requestKey;
    request.current.generation += 1;
  }
  useEffect(() => {
    if (!runId) return;
    let current = true;
    const generation = request.current.generation;
    setGraph(empty);
    setLoadedRunId('');
    setError('');
    setCursor(null);
    setWatermark(null);
    setLoading(true);
    const query = new URLSearchParams({ run_id: runId, limit: '200' });
    void api<RunGraphPage>(`repos/${repo}/run_graph_page?${query}`)
      .then((page) => {
        if (current && request.current.generation === generation) {
          setGraph(mergeRunGraphPage(empty, page));
          setLoadedRunId(runId);
          setCursor(page.has_more ? page.next_cursor : null);
          setWatermark(page.watermark);
        }
      })
      .catch((failure: unknown) => {
        if (current && request.current.generation === generation)
          setError((failure as Error).message);
      })
      .finally(() => {
        if (current && request.current.generation === generation) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [request, repo, runId]);
  async function loadMore() {
    if (!runId || loadedRunId !== runId || !cursor || watermark === null || loading) return;
    const generation = request.current.generation;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({
      run_id: runId,
      limit: '200',
      cursor,
      watermark: String(watermark),
    });
    try {
      const page = await api<RunGraphPage>(`repos/${repo}/run_graph_page?${query}`);
      if (request.current.generation === generation) {
        setGraph((before) => mergeRunGraphPage(before, page));
        setCursor(page.has_more ? page.next_cursor : null);
        setWatermark(page.watermark);
      }
    } catch (failure) {
      if (request.current.generation === generation) setError((failure as Error).message);
    } finally {
      if (request.current.generation === generation) setLoading(false);
    }
  }
  return { graph, runId: loadedRunId, error, cursor, loading, loadMore };
}
