// "Rebase on main" for an open change: replays its branch onto main's head on the server
// (POST branches/<name>/rebase). Offered while the branch is behind main; a conflict lists
// its paths and the branch stays as it was.
import { useState } from 'react';
import { type Conflict, ConflictList } from './CommitGates';
import type { ChangeDetail } from './changeModel';
import { Failure } from './SourceStatus';
import { type SourceApiError, sourceApi } from './sourceApi';
import { useSource } from './useSource';

export type RebaseState = 'behind' | 'current' | 'unknown';

/** Behind when main's head is not the merge base the change's diff was taken from. */
export function rebaseState(change: ChangeDetail, mainHead: string | undefined): RebaseState {
  if (!mainHead || !change.head || !change.diff) return 'unknown';
  return change.diff.base?.commit === mainHead ? 'current' : 'behind';
}

export function RebaseButton({
  repo,
  change,
  onChanged,
}: {
  repo: string;
  change: ChangeDetail;
  onChanged: () => void;
}) {
  const refs = useSource<{ refs?: Record<string, string> }>(`/repos/${repo}/refs`);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const state = rebaseState(change, refs.data?.refs?.[`refs/heads/${change.base}`]);
  async function rebase() {
    setBusy(true);
    setNotice('');
    setError('');
    setConflicts([]);
    try {
      const branch = change.branch.split('/').map(encodeURIComponent).join('/');
      const done = await sourceApi(`/repos/${repo}/branches/${branch}/rebase`, {
        body: { onto: change.base },
      });
      setNotice(
        done.up_to_date
          ? `Already on ${change.base}.`
          : `Rebased ${done.commits.length} commit(s) on ${change.base}.`,
      );
      refs.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setConflicts((e as SourceApiError).details?.conflicts ?? []);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-gates" aria-label="Rebase">
      <div className="source-actions">
        <button type="button" disabled={busy || state !== 'behind'} onClick={rebase}>
          {busy ? 'Rebasing…' : `Rebase on ${change.base}`}
        </button>
        {state === 'current' && <span className="source-meta">Up to date with {change.base}.</span>}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <Failure error={error} />}
      <ConflictList conflicts={conflicts} />
    </section>
  );
}
