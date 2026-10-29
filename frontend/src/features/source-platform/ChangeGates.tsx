// A change's reviews and actions (its gates are MergeGates, above it): approve or reject the head, land it on its base
// (gated when the base is protected), close, reopen or delete (a closed change, by its
// author or the owner). The server decides each one; the panel only offers what the status allows.
import { useState } from 'react';
import { type Conflict, ConflictList, ReviewButtons } from './CommitGates';
import { type ChangeDetail, who } from './changeModel';
import { useReadOnly } from './repoAccess';
import { Failure } from './SourceStatus';
import { type SourceApiError, shortSha, sourceApi, when } from './sourceApi';

export function ChangeGates({
  repo,
  change,
  onChanged,
  onDeleted,
}: {
  repo: string;
  change: ChangeDetail;
  onChanged: () => void;
  /** After the change is deleted (it no longer exists to show). */
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  // A public reader sees the gates and reviews, never the actions.
  const readOnly = useReadOnly();
  async function act(label: string, path: string, body: unknown, done: string, method?: 'DELETE') {
    setBusy(label);
    setNotice('');
    setError('');
    setConflicts([]);
    try {
      await sourceApi(`/repos/${repo}${path}`, method ? { method } : { body });
      setNotice(done);
      if (method) onDeleted?.();
      else onChanged();
    } catch (e) {
      setError((e as Error).message);
      setConflicts((e as SourceApiError).details?.conflicts ?? []);
    } finally {
      setBusy('');
    }
  }
  const { head, head_commit: commit, status } = change;
  const base = `/changes/${change.number}`;
  return (
    <section className="source-gates" aria-label="Landing gates">
      {status === 'landed' && (
        <p className="source-change-banner">
          Landed on {change.base}
          {change.landed_version !== null && ` at v${change.landed_version}`}
          {change.landed_commit && (
            <>
              {' as '}
              <code>{shortSha(change.landed_commit)}</code>
            </>
          )}
          .
        </p>
      )}
      {status === 'closed' && <p className="source-change-banner">Closed without landing.</p>}
      {!head && status !== 'landed' && (
        <p className="source-change-banner">
          The branch <code>{change.branch}</code> no longer exists.
        </p>
      )}
      {commit && commit.reviews.length > 0 && (
        <ul className="source-reviews" aria-label="Reviews of the head commit">
          {commit.reviews.map((r) => (
            <li key={r.principal}>
              {who(r.principal)} {r.decision === 'approve' ? 'approved' : 'rejected'}
              {r.reason && `: ${r.reason}`} · {when(r.recorded_at)}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="source-actions">
          {status === 'open' && head && (
            <>
              <ReviewButtons
                disabled={!!busy}
                onReview={(decision, reason) =>
                  act(
                    decision,
                    `/commits/${head}/reviews`,
                    { decision, reason },
                    decision === 'approve' ? 'Approved.' : 'Rejected.',
                  )
                }
              />
              <button
                type="button"
                disabled={!!busy || (change.base_protected !== false && !commit?.gates.ready)}
                onClick={() =>
                  act(
                    'land',
                    '/land',
                    { ref: change.base, commit: head },
                    `Landed on ${change.base}.`,
                  )
                }
              >
                {busy === 'land' ? 'Landing…' : `Land on ${change.base}`}
              </button>
            </>
          )}
          {status === 'open' && (
            <button
              type="button"
              className="quiet"
              disabled={!!busy}
              onClick={() => act('close', `${base}/close`, {}, 'Closed.')}
            >
              Close change
            </button>
          )}
          {status === 'closed' && (
            <button
              type="button"
              className="quiet"
              disabled={!!busy}
              onClick={() => act('reopen', `${base}/reopen`, {}, 'Reopened.')}
            >
              Reopen change
            </button>
          )}
          {status === 'closed' && (
            <button
              type="button"
              className="danger"
              disabled={!!busy}
              onClick={() => {
                const what = `Delete change #${change.number} and its comments? The branch stays.`;
                if (window.confirm(what)) act('delete', base, undefined, 'Deleted.', 'DELETE');
              }}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete change'}
            </button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <Failure error={error} />}
      <ConflictList conflicts={conflicts} />
    </section>
  );
}
