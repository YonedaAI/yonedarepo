import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, onUnauthorized } from '../lib/api';
import type { AccountIdentity, ProjectMetadata, Repository, Snapshot } from '../lib/types';
import { coalesceRefresh } from './refreshCoalescer';
import { RepositoryReads } from './repositoryReads';
import { refreshRepository } from './repositoryRefresh';
import { selectRepository, withoutRepositoryLink } from './repositorySelection';

const LIVE_REFRESH_INTERVAL_MS = 3000;

export function useRepository() {
  const [deepLink] = useState(
    () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
  );
  const requestedRepositoryId = deepLink.get('repo') ?? '';
  const requestedRunId = deepLink.get('run') ?? '';
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [id, setCurrentId] = useState(requestedRepositoryId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  const [authenticated, setAuthenticated] = useState(false);
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;
  // A signed-in session that the server stopped accepting, e.g. evicted by a newer sign-in.
  const [sessionEnded, setSessionEnded] = useState(false);
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
  const linkFollowed = useRef(false);
  const reads = useRef(new RepositoryReads());
  const requests = useRef(new Map<string, { promise: Promise<void>; signal?: AbortSignal }>());
  const clear = useCallback(() => {
    generation.current++;
    selectedId.current = requestedRepositoryId;
    deletedIds.current.clear();
    reads.current.cancel();
    setAuthenticated(false);
    authenticatedRef.current = false;
    setIdentity(null);
    setRepositories([]);
    setCurrentId('');
    setSnapshot(null);
    snapshotRef.current = null;
    setRequestedRunError('');
    setError('');
    setLoading(false);
  }, [requestedRepositoryId, setError]);
  const endSession = useCallback(() => {
    const wasSignedIn = authenticatedRef.current;
    clear();
    if (wasSignedIn) setSessionEnded(true);
  }, [clear]);
  const fail = useCallback(
    (e: unknown, polling = false) => {
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED') endSession();
      else if (polling) setPollError((e as Error).message);
      else setError((e as Error).message);
    },
    [endSession, setError],
  );
  useEffect(
    () =>
      onUnauthorized(() => {
        if (authenticatedRef.current) endSession();
      }),
    [endSession],
  );
  const discover = useCallback(async () => {
    reads.current.cancel();
    const controller = reads.current.begin();
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ repositories: Repository[]; identity?: AccountIdentity }>(
        'repositories',
        undefined,
        { signal: controller.signal },
      );
      if (generation.current !== current || controller.signal.aborted) return;
      const available = result.repositories.filter(
        (repo) => repo.status !== 'deleted' && !deletedIds.current.has(repo.id),
      );
      setAuthenticated(true);
      setSessionEnded(false);
      setIdentity(result.identity ?? null);
      setRepositories(available);
      const { id: next, missing } = selectRepository({
        requested: requestedRepositoryId,
        current: selectedId.current,
        available,
        deleted: deletedIds.current,
        linkFollowed: linkFollowed.current,
      });
      if (requestedRepositoryId && !linkFollowed.current) {
        linkFollowed.current = true;
        // A stale link must not reappear on reload or after the next delete.
        if (missing && typeof window !== 'undefined')
          window.history.replaceState(null, '', withoutRepositoryLink(window.location.href));
      }
      if (next !== selectedId.current) setSnapshot(null);
      selectedId.current = next;
      setCurrentId(next);
      setError(missing ? `Repository "${requestedRepositoryId}" was not found for this link.` : '');
    } catch (e) {
      if (generation.current === current && !controller.signal.aborted) fail(e);
    } finally {
      reads.current.end(controller);
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
    if (pending && !pending.signal?.aborted) {
      await pending.promise.catch(() => {});
      return;
    }
    const controller = reads.current.begin();
    const stillCurrent = () =>
      generation.current === current &&
      id === selectedId.current &&
      !deletedIds.current.has(id) &&
      !controller.signal.aborted;
    const load = <T>(path: string) => api<T>(path, undefined, { signal: controller.signal });
    const request = (async () => {
      try {
        if (project?.status === 'provisioning' || project?.status === 'failed') {
          const result = await load<ProjectMetadata>(`projects/${id}`);
          if (stillCurrent()) {
            updateProject(result, id);
            setPollError('');
          }
          return;
        }
        await refreshRepository({
          id,
          load,
          snapshot: snapshotRef.current,
          requestedRunId: id === requestedRepositoryId ? requestedRunId : '',
          isCurrent: stillCurrent,
          onRequestedRunError: (message) => {
            if (stillCurrent()) setRequestedRunError(message);
          },
          onSnapshot: (next) => {
            if (!stillCurrent()) return;
            if (snapshotRef.current?.repository.id === id && snapshotRef.current.seq > next.seq)
              return;
            snapshotRef.current = next;
            setRepositories((previous) =>
              previous.map((repo) => (repo.id === id ? { ...repo, ...next.repository } : repo)),
            );
            setSnapshot((previous) =>
              previous && previous.repository.id === id && previous.seq > next.seq
                ? previous
                : next,
            );
          },
        });
        setPollError('');
      } catch (e) {
        if (!stillCurrent() || controller.signal.aborted) return;
        if (e instanceof ApiError && e.code === 'REPOSITORY_DELETED') {
          reads.current.cancel();
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
    requests.current.set(key, { promise: request, signal: controller.signal });
    try {
      await request;
    } finally {
      reads.current.end(controller);
      if (requests.current.get(key)?.promise === request) requests.current.delete(key);
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
    reads.current.cancel();
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
    requests.current.set(key, { promise: request });
    try {
      await request;
    } finally {
      if (requests.current.get(key)?.promise === request) requests.current.delete(key);
    }
  }, [id, fail, updateProject, setError]);
  const setId = useCallback(
    (id: string) => {
      if (deletedIds.current.has(id)) return;
      generation.current++;
      selectedId.current = id;
      setCurrentId(id);
      setSnapshot(null);
      snapshotRef.current = null;
      reads.current.cancel();
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
      reads.current.cancel();
      deletedIds.current.add(repository.id);
      // A reload must not follow a link to the repository that no longer exists.
      if (repository.id === requestedRepositoryId && typeof window !== 'undefined')
        window.history.replaceState(null, '', withoutRepositoryLink(window.location.href));
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
    [repositories, discover, requestedRepositoryId, setError],
  );
  const signOut = useCallback(async () => {
    reads.current.cancel();
    await api('auth/logout', {});
    const result = await fetch('/api/session', { method: 'DELETE' });
    // An account-only session is already anonymous after logout.
    if (!result.ok && result.status !== 401)
      throw new Error('Could not disconnect administrator access. Try signing out again.');
    clear();
    setSessionEnded(false);
  }, [clear]);
  useEffect(() => {
    void discover();
    return () => reads.current.cancel();
  }, [discover]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(timer);
      reads.current.cancel();
    };
  }, [refresh]);
  useEffect(() => {
    if (!id || project?.status !== 'ready') return;
    const url = new URL(`/api/repos/${id}/live`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    // Busy runs emit many resync signals; refresh at most every few seconds, keeping the last.
    const live = coalesceRefresh(refresh, LIVE_REFRESH_INTERVAL_MS);
    ws.onmessage = () => live.signal();
    ws.onopen = () => live.signal();
    return () => {
      live.stop();
      ws.close();
    };
  }, [id, project?.status, refresh]);
  return {
    repositories,
    project,
    id,
    setId,
    snapshot: snapshot?.repository.id === id && !deletedIds.current.has(id) ? snapshot : null,
    authenticated,
    sessionEnded,
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
