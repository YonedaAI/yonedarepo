import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ConflictStatus, Repository } from '../../lib/types';

export function ConflictStatusPanel({
  repository,
  reviewer = false,
  onChange,
  onError,
}: {
  repository: Repository;
  reviewer?: boolean;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<ConflictStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [briefs, setBriefs] = useState<Record<string, string>>({});
  const pendingRequests = useRef(new Map<string, Record<string, unknown>>());
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStatus(await api<ConflictStatus>(`repos/${repository.id}/conflict_status`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repository.id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(
    action: 'refresh_candidate' | 'resolve_conflict',
    conflict: ConflictStatus['conflicts'][number],
  ) {
    const key = `${action}:${conflict.conflict_id}`;
    let body = pendingRequests.current.get(key);
    if (!body) {
      body = {
        request_id: crypto.randomUUID(),
        candidate_id: conflict.candidate_id,
        ...(conflict.declared_paths ? { declared_paths: conflict.declared_paths } : {}),
        ...(action === 'resolve_conflict'
          ? { conflict_id: conflict.conflict_id, owner_brief: briefs[conflict.conflict_id] }
          : {}),
        expected_commit: repository.head_commit,
        expected_version: repository.version,
      };
      pendingRequests.current.set(key, body);
    }
    setBusy(key);
    setError('');
    try {
      await api(`repos/${repository.id}/${action}`, body);
      pendingRequests.current.delete(key);
      await onChange();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      onError((e as Error).message);
      // Keep the exact request body and ID so a retry can recover a lost acknowledgment safely.
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="conflict-status" aria-labelledby="conflict-status-title">
      <div className="history-heading">
        <h2 id="conflict-status-title">Revision conflicts</h2>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void refresh()}
        >
          Refresh status
        </button>
      </div>
      {loading && <p role="status">Loading conflict and overlap status…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && status && !status.conflicts.length && !status.overlaps.length && (
        <p className="empty-note">No stale candidates or path overlaps are recorded.</p>
      )}
      {!!status?.overlaps.length && (
        <div>
          <h3>Overlapping task paths</h3>
          <ul>
            {status.overlaps.map((overlap) => (
              <li key={`${overlap.path}:${overlap.candidates.join(',')}`}>
                <code>{overlap.path}</code> · {overlap.candidates.join(' and ')} ·{' '}
                {overlap.status.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!status?.conflicts.length && (
        <ol>
          {status.conflicts.map((conflict) => (
            <li key={conflict.conflict_id}>
              <h3>Candidate needs a scoped repair</h3>
              <p>
                {conflict.message ||
                  `Expected ${conflict.expected_commit}; repository is now ${repository.head_commit}.`}
              </p>
              {!reviewer && (
                <div className="conflict-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={!!busy}
                    onClick={() => void mutate('refresh_candidate', conflict)}
                  >
                    {busy === `refresh_candidate:${conflict.conflict_id}`
                      ? 'Refreshing candidate…'
                      : 'Refresh candidate'}
                  </button>
                  <label>
                    Owner brief for the scoped resolver
                    <textarea
                      value={briefs[conflict.conflict_id] ?? ''}
                      disabled={pendingRequests.current.has(
                        `resolve_conflict:${conflict.conflict_id}`,
                      )}
                      onChange={(event) =>
                        setBriefs((old) => ({ ...old, [conflict.conflict_id]: event.target.value }))
                      }
                      rows={3}
                      maxLength={4000}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!!busy || !(briefs[conflict.conflict_id] ?? '').trim()}
                    onClick={() => void mutate('resolve_conflict', conflict)}
                  >
                    {busy === `resolve_conflict:${conflict.conflict_id}`
                      ? 'Starting scoped repair…'
                      : pendingRequests.current.has(`resolve_conflict:${conflict.conflict_id}`)
                        ? 'Retry scoped repair request'
                        : 'Resolve with fresh capture and checks'}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
