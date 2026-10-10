import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import type {
  AccountIdentity,
  ProjectMetadata,
  Repository,
  RepositoryOverview,
  RunDetail,
  RunsPage,
  Snapshot,
} from '../lib/types';
import {
  emptySnapshot,
  findRunInPages,
  mergeRunDetails,
  RequestedRunNotFoundError,
  scopedRunIds,
} from './repositorySnapshot';

export function useRepository() {
  const deepLink = useRef<{ repositoryId: string; runId: string } | null>(null);
  if (!deepLink.current) {
    const query =
      typeof window === 'undefined'
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search);
    deepLink.current = { repositoryId: query.get('repo') ?? '', runId: query.get('run') ?? '' };
  }
  const requestedRepositoryId = deepLink.current.repositoryId;
  const requestedRunId = deepLink.current.runId;
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [id, setCurrentId] = useState(requestedRepositoryId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  const [authenticated, setAuthenticated] = useState(false);
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [actionError, setActionError] = useState('');
  const [pollError, setPollError] = useState('');
  const [requestedRunError, setRequestedRunError] = useState('');
  const setError = useCallback((message: string) => {
    setActionError(message);
    setPollError('');
  }, []);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const selectedId = useRef(requestedRepositoryId);
  const deletedIds = useRef(new Set<string>());
  const requestedRunMissing = useRef(false);
  const requests = useRef(new Map<string, Promise<void>>());
  const clear = useCallback(() => {
    generation.current++;
    selectedId.current = requestedRepositoryId;
    deletedIds.current.clear();
    requestedRunMissing.current = false;
    setAuthenticated(false);
    setIdentity(null);
    setRepositories([]);
    setCurrentId('');
    setSnapshot(null);
    setRequestedRunError('');
    setError('');
    setLoading(false);
  }, [requestedRepositoryId, setError]);
  const fail = useCallback(
    (e: unknown, polling = false) => {
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') clear();
      else if (polling) setPollError((e as Error).message);
      else setError((e as Error).message);
    },
    [clear, setError],
  );
  const discover = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ repositories: Repository[]; identity?: AccountIdentity }>(
        'repositories',
      );
      if (generation.current !== current) return;
      const available = result.repositories.filter(
        (repo) => repo.status !== 'deleted' && !deletedIds.current.has(repo.id),
      );
      setAuthenticated(true);
      setIdentity(result.identity ?? null);
      setRepositories(available);
      if (requestedRepositoryId && !available.some((repo) => repo.id === requestedRepositoryId)) {
        selectedId.current = '';
        setCurrentId('');
        setSnapshot(null);
        setError(`Repository "${requestedRepositoryId}" was not found for this link.`);
        return;
      }
      const next = available.some((repo) => repo.id === selectedId.current)
        ? selectedId.current
        : (available[0]?.id ?? '');
      if (next !== selectedId.current) setSnapshot(null);
      selectedId.current = next;
      setCurrentId(next);
      setError('');
    } catch (e) {
      if (generation.current === current) fail(e);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [fail, requestedRepositoryId, setError]);
  const updateProject = useCallback((result: ProjectMetadata, requestedId: string) => {
    if (result.id !== requestedId || !['provisioning', 'ready', 'failed'].includes(result.status))
      throw new Error('The repository setup response could not be verified. Refresh its status.');
    setRepositories((previous) =>
      previous.map((repo) => (repo.id === requestedId ? { ...repo, ...result } : repo)),
    );
  }, []);
  const project = repositories.find((repo) => repo.id === id);
  const refresh = useCallback(async () => {
    if (!id || id !== selectedId.current || deletedIds.current.has(id)) return;
    const current = generation.current;
    const key = `${current}:${id}`;
    const pending = requests.current.get(key);
    if (pending) {
      await pending.catch(() => {});
      return;
    }
    const stillCurrent = () =>
      generation.current === current && id === selectedId.current && !deletedIds.current.has(id);
    const request = (async () => {
      try {
        if (project?.status === 'provisioning' || project?.status === 'failed') {
          const result = await api<ProjectMetadata>(`projects/${id}`);
          if (stillCurrent()) {
            updateProject(result, id);
            setPollError('');
          }
          return;
        }
        const currentSnapshot = snapshotRef.current;
        const [overview, page] = await Promise.all([
          api<RepositoryOverview>(`repos/${id}/overview`),
          api<RunsPage>(`repos/${id}/runs?limit=25`),
        ]);
        if (!stillCurrent() || overview.repository.id !== id) return;
        setRepositories((previous) =>
          previous.map((repo) => (repo.id === id ? { ...repo, ...overview.repository } : repo)),
        );
        const baseSnapshot =
          currentSnapshot?.repository.id === id ? currentSnapshot : emptySnapshot(overview);
        const requestedRunForRepository = id === requestedRepositoryId ? requestedRunId : '';
        let requestedRunFound = !requestedRunForRepository
          ? undefined
          : baseSnapshot.runs.find((run) => run.id === requestedRunForRepository);
        if (requestedRunForRepository && !requestedRunFound && !requestedRunMissing.current) {
          try {
            requestedRunFound = await findRunInPages(
              requestedRunForRepository,
              page,
              (cursor, watermark) => {
                const query = new URLSearchParams({
                  limit: '25',
                  cursor,
                  watermark: String(watermark),
                });
                return api<RunsPage>(`repos/${id}/runs?${query}`);
              },
            );
            if (!stillCurrent()) return;
            setRequestedRunError('');
          } catch (error) {
            if (!stillCurrent()) return;
            if (error instanceof RequestedRunNotFoundError) {
              requestedRunMissing.current = true;
              setRequestedRunError(error.message);
            } else throw error;
          }
        }
        const runIds = scopedRunIds(page.items, baseSnapshot.runs);
        if (requestedRunFound && !runIds.includes(requestedRunForRepository))
          runIds.push(requestedRunForRepository);
        const details = await Promise.all(
          runIds.map((runId) => api<RunDetail>(`repos/${id}/runs/${encodeURIComponent(runId)}`)),
        );
        if (!stillCurrent()) return;
        const next = mergeRunDetails(baseSnapshot, details, overview);
        setSnapshot((previous) =>
          previous && previous.repository.id === id && previous.seq > next.seq ? previous : next,
        );
        setPollError('');
      } catch (e) {
        if (!stillCurrent()) return;
        if (e instanceof ApiError && e.code === 'REPOSITORY_DELETED') {
          deletedIds.current.add(id);
          generation.current++;
          selectedId.current = '';
          setCurrentId('');
          setSnapshot(null);
          setRepositories((previous) => previous.filter((repo) => repo.id !== id));
          setError('');
          await discover();
        } else fail(e, true);
      }
    })();
    requests.current.set(key, request);
    try {
      await request;
    } finally {
      if (requests.current.get(key) === request) requests.current.delete(key);
    }
  }, [
    id,
    fail,
    project?.status,
    discover,
    updateProject,
    setError,
    requestedRepositoryId,
    requestedRunId,
  ]);
  const retrySetup = useCallback(async () => {
    if (!id || id !== selectedId.current || deletedIds.current.has(id)) return;
    const current = ++generation.current;
    const key = `${current}:${id}`;
    const stillCurrent = () =>
      generation.current === current && id === selectedId.current && !deletedIds.current.has(id);
    setError('');
    const request = (async () => {
      try {
        const result = await api<ProjectMetadata>(`projects/${id}/retry`, {});
        if (stillCurrent()) updateProject(result, id);
      } catch (e) {
        if (stillCurrent()) fail(e);
        throw e;
      }
    })();
    requests.current.set(key, request);
    try {
      await request;
    } finally {
      if (requests.current.get(key) === request) requests.current.delete(key);
    }
  }, [id, fail, updateProject, setError]);
  const setId = useCallback(
    (id: string) => {
      if (deletedIds.current.has(id)) return;
      generation.current++;
      selectedId.current = id;
      setCurrentId(id);
      setSnapshot(null);
      requestedRunMissing.current = false;
      setRequestedRunError('');
      setError('');
      setLoading(false);
    },
    [setError],
  );
  const deleteRepository = useCallback(
    async (repository: Repository, confirmName: string) => {
      const result = await api<{ status: string; cleanup_pending: boolean }>(
        `repos/${encodeURIComponent(repository.id)}/delete_repository`,
        { confirm_name: confirmName },
      );
      if (result.status !== 'deleted') throw new Error('Repository deletion was not confirmed.');
      deletedIds.current.add(repository.id);
      generation.current++;
      const remaining = repositories.filter((repo) => !deletedIds.current.has(repo.id));
      setRepositories(remaining);
      if (selectedId.current === repository.id) {
        selectedId.current = remaining[0]?.id ?? '';
        setCurrentId(selectedId.current);
        setSnapshot(null);
      }
      setError('');
      await discover();
      return { cleanup_pending: result.cleanup_pending !== false };
    },
    [repositories, discover, setError],
  );
  const signOut = useCallback(async () => {
    await api('auth/logout', {});
    const result = await fetch('/api/session', { method: 'DELETE' });
    // An account-only session is already anonymous after logout.
    if (!result.ok && result.status !== 401)
      throw new Error('Could not disconnect administrator access. Try signing out again.');
    clear();
  }, [clear]);
  useEffect(() => {
    void discover();
  }, [discover]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!id || project?.status !== 'ready') return;
    const url = new URL(`/api/repos/${id}/live`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    ws.onmessage = () => void refresh();
    ws.onopen = () => void refresh();
    return () => ws.close();
  }, [id, project?.status, refresh]);
  return {
    repositories,
    project,
    id,
    setId,
    snapshot: snapshot?.repository.id === id && !deletedIds.current.has(id) ? snapshot : null,
    authenticated,
    identity,
    error: actionError || pollError,
    setError,
    loading,
    discover,
    refresh,
    retrySetup,
    clear,
    signOut,
    deleteRepository,
    requestedRunId: id === requestedRepositoryId ? requestedRunId : '',
    requestedRunError,
  };
}
