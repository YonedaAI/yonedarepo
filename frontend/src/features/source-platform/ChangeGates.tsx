// A change's landing gates and its actions: approve or reject the head, land it on main,
// close or reopen. The server decides each one; the panel only offers what the status allows.
import { useState } from 'react';
import { type Conflict, ConflictList, GateSummary, ReviewButtons } from './CommitGates';
import { type ChangeDetail, who } from './changeModel';
import { Failure } from './SourceStatus';
import { type SourceApiError, shortSha, sourceApi, when } from './sourceApi';

export function ChangeGates({
  repo,
  change,
  onChanged,
}: {
  repo: string;
  change: ChangeDetail;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  async function act(label: string, path: string, body: unknown, done: string) {
    setBusy(label);
    setNotice('');
    setError('');
    setConflicts([]);
    try {
      await sourceApi(`/repos/${repo}${path}`, { body });
      setNotice(done);
      onChanged();
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
      {commit && status !== 'landed' && (
        <GateSummary gates={commit.gates} classes={commit.review_classes} landings={[]} />
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
              disabled={!!busy || !commit?.gates.ready}
              onClick={() => act('land', '/land', { ref: 'main', commit: head }, 'Landed on main.')}
            >
              {busy === 'land' ? 'Landing…' : 'Land on main'}
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
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <Failure error={error} />}
      <ConflictList conflicts={conflicts} />
    </section>
  );
}
