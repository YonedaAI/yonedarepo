import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Repository, Snapshot } from '../lib/types';
export function useRepository() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [id, setId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const discover = useCallback(async () => {
    try {
      const result = await api<{ repositories: Repository[] }>('repositories');
      setRepositories(result.repositories);
      setId((current) => current || result.repositories[0]?.id || '');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api<Snapshot>(`repos/${id}/snapshot`);
      result.runs.sort((a, b) => a.created_at - b.created_at);
      setSnapshot(result);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void discover();
  }, [discover]);
  useEffect(() => {
    setSnapshot(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!id) return;
    const url = new URL(`/api/repos/${id}/live`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    ws.onmessage = () => void refresh();
    ws.onopen = () => void refresh();
    return () => ws.close();
  }, [id, refresh]);
  return { repositories, id, setId, snapshot, error, setError, loading, discover, refresh };
}
