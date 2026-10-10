import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ConflictStatus, Repository } from '../../lib/types';
import {
  type ConflictInventoryItem,
  type ConflictInventoryView,
  normalizeConflictInventory,
} from './conflictInventory';

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
  const [status, setStatus] = useState<ConflictInventoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [briefs, setBriefs] = useState<Record<string, string>>({});
  const pendingRequests = useRef(new Map<string, Record<string, unknown>>());
  const refresh = useCallback(
    async (background = false) => {
      if (!background) {
        setLoading(true);
        setError('');
      }
      try {
        const inventory = await api<ConflictStatus>(`repos/${repository.id}/conflict_status`);
        setStatus(normalizeConflictInventory(inventory));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (!background) setLoading(false);
      }
    },
    [repository.id],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const active = status?.records.some((record) =>
      ['refreshing', 'resolving', 'evaluating'].includes(record.status ?? ''),
    );
    if (!active) return;
    const timer = globalThis.setInterval(() => void refresh(true), 2000);
    return () => globalThis.clearInterval(timer);
  }, [refresh, status]);

  async function mutate(
    action: 'refresh_candidate' | 'resolve_conflict',
    conflict: ConflictInventoryItem,
  ) {
    const key = `${action}:${conflict.key}`;
    let body = pendingRequests.current.get(key);
    if (!body) {
      body = {
        request_id: crypto.randomUUID(),
        candidate_id: conflict.candidate_id,
        ...(conflict.conflict_paths.length ? { declared_paths: conflict.conflict_paths } : {}),
        ...(action === 'resolve_conflict'
          ? { conflict_id: conflict.conflict_id, owner_brief: briefs[conflict.key] }
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
      {reviewer && (
        <p className="empty-note">
          Refresh and repair actions use the existing reviewer approval and shared trial allowance.
        </p>
      )}
      {!loading && status && !status.records.length && !status.overlaps.length && (
        <p className="empty-note">No stale candidates or path overlaps are recorded.</p>
      )}
      {!!status?.overlaps.length && (
        <div>
          <h3>Overlapping task paths</h3>
          <ul>
            {status.overlaps.map((overlap) => (
              <li key={overlap.key}>
                {overlap.paths.map((path) => (
                  <code key={path}>{path}</code>
                ))}{' '}
                · candidate <code>{overlap.candidate_id}</code> ·{' '}
                {overlap.status.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!status?.records.length && (
        <ol>
          {status.records.map((conflict) => (
            <li key={conflict.key}>
              <h3>
                {conflict.kind === 'stale_candidate'
                  ? 'Candidate needs a fresh base revision'
                  : conflict.kind === 'unresolved_conflict'
                    ? 'Candidate needs a scoped repair'
                    : 'Conflict lifecycle record'}
              </h3>
              <p>
                Candidate <code>{conflict.candidate_id}</code>
                {conflict.head_commit && (
                  <>
                    {' '}
                    was captured at <code>{conflict.head_commit}</code>
                  </>
                )}
                {conflict.expected_version !== undefined &&
                  ` (version ${conflict.expected_version})`}
                . Current head is <code>{repository.head_commit}</code>.
              </p>
              {conflict.status && <p>Lifecycle status: {conflict.status.replaceAll('_', ' ')}.</p>}
              {conflict.conflict_id && (
                <p>
                  Conflict record <code>{conflict.conflict_id}</code>
                </p>
              )}
              {conflict.refreshed_candidate_id && (
                <p>
                  Refreshed candidate: <code>{conflict.refreshed_candidate_id}</code>
                </p>
              )}
              {conflict.resolver_candidate_id && (
                <p>
                  Resolver candidate: <code>{conflict.resolver_candidate_id}</code>
                </p>
              )}
              {conflict.conflict_paths.length > 0 && (
                <p>
                  Affected paths:{' '}
                  {conflict.conflict_paths.map((path) => (
                    <code key={path}>{path} </code>
                  ))}
                </p>
              )}
              <div className="conflict-actions">
                {conflict.kind === 'stale_candidate' ||
                (conflict.kind === 'refresh_record' &&
                  ['failed', 'stale'].includes(conflict.status ?? '')) ? (
                  <button
                    type="button"
                    className="quiet"
                    disabled={!!busy}
                    onClick={() => void mutate('refresh_candidate', conflict)}
                  >
                    {busy === `refresh_candidate:${conflict.key}`
                      ? 'Refreshing candidate…'
                      : reviewer
                        ? 'Refresh candidate using existing trial approval'
                        : 'Refresh candidate'}
                  </button>
                ) : conflict.kind === 'unresolved_conflict' ? (
                  <>
                    <label>
                      Owner brief for the scoped resolver
                      <textarea
                        value={briefs[conflict.key] ?? ''}
                        disabled={pendingRequests.current.has(`resolve_conflict:${conflict.key}`)}
                        onChange={(event) =>
                          setBriefs((old) => ({ ...old, [conflict.key]: event.target.value }))
                        }
                        rows={3}
                        maxLength={4000}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!!busy || !(briefs[conflict.key] ?? '').trim()}
                      onClick={() => void mutate('resolve_conflict', conflict)}
                    >
                      {busy === `resolve_conflict:${conflict.key}`
                        ? 'Starting scoped repair…'
                        : pendingRequests.current.has(`resolve_conflict:${conflict.key}`)
                          ? 'Retry scoped repair request'
                          : reviewer
                            ? 'Resolve using existing trial approval'
                            : 'Resolve with fresh capture and checks'}
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
