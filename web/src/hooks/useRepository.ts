import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import type { Repository, Snapshot } from '../lib/types';
export function useRepository() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [id, setCurrentId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const clear = useCallback(() => {
    generation.current++;
    setAuthenticated(false);
    setRepositories([]);
    setCurrentId('');
    setSnapshot(null);
    setError('');
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') clear();
      else setError((e as Error).message);
    },
    [clear],
  );
  const discover = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ repositories: Repository[] }>('repositories');
      if (generation.current !== current) return;
      setAuthenticated(true);
      setRepositories(result.repositories);
      setCurrentId((id) =>
        result.repositories.some((repo) => repo.id === id) ? id : result.repositories[0]?.id || '',
      );
      setError('');
    } catch (e) {
      if (generation.current === current) fail(e);
    } finally {
      setLoading(false);
    }
  }, [fail]);
  const project = repositories.find((repo) => repo.id === id);
  const refresh = useCallback(async () => {
    if (!id) return;
    if (project?.status === 'provisioning' || project?.status === 'failed') {
      if (project.status === 'provisioning') {
        await api(`projects/${id}`);
        await discover();
      }
      return;
    }
    const current = generation.current;
    try {
      const result = await api<Snapshot>(`repos/${id}/snapshot`);
      if (generation.current !== current) return;
      result.runs.sort((a, b) => a.created_at - b.created_at);
      setSnapshot((previous) =>
        previous && previous.repository.id === result.repository.id && previous.seq > result.seq
          ? previous
          : result,
      );
      setError('');
    } catch (e) {
      if (generation.current === current) fail(e);
    }
  }, [id, fail, project?.status, discover]);
  const setId = useCallback((id: string) => {
    generation.current++;
    setCurrentId(id);
  }, []);
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
  return {
    repositories,
    project,
    id,
    setId,
    snapshot,
    authenticated,
    error,
    setError,
    loading,
    discover,
    refresh,
    clear,
  };
}
