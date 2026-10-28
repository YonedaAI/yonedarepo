import { useState } from 'react';
import { useReadOnly } from './repoAccess';
import { Failure } from './SourceStatus';
import { shortSha, sourceApi, when } from './sourceApi';

export type BreakGlassRecord = {
  seq: number;
  action: string;
  refname: string | null;
  commit_id: string | null;
  target_commit: string | null;
  actor: string;
  reason: string;
  created_at: number;
};

function describe(r: BreakGlassRecord, commit: string) {
  if (r.action === 'land') return 'landed';
  if (r.commit_id === commit) return `landed a revert of ${shortSha(r.target_commit ?? '')}`;
  return `reverted by ${shortSha(r.commit_id ?? '')}`;
}

/** What break glass did to this commit, for the record. */
export function BreakGlassRecords({
  commit,
  records,
}: {
  commit: string;
  records: BreakGlassRecord[];
}) {
  return records.map((r) => (
    <p key={r.seq} className="source-break-glass-record">
      <span className="source-badge-danger">Break-glass</span> {describe(r, commit)} on{' '}
      {(r.refname ?? '').replace(/^refs\/heads\//, '')} by {r.actor} · {when(r.created_at)} —{' '}
      {r.reason}
    </p>
  ));
}

/**
 * Owner recovery when automation is broken: land past failing or pending checks, or revert
 * a landed commit. The server refuses anyone but a signed-in human owner; this control only
 * asks for a reason and pins the head the person confirmed against (stale heads are refused).
 */
export function BreakGlass({
  repo,
  commit,
  target,
  landedOn,
  records,
  onDone,
}: {
  repo: string;
  commit: string;
  target: string;
  landedOn: string[];
  records: BreakGlassRecord[];
  onDone: (result: { commit?: string; already?: boolean }) => void;
}) {
  const action = landedOn.includes(`refs/heads/${target}`) ? 'revert' : 'land';
  const [head, setHead] = useState<string | null | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A public reader sees the record of past break-glass actions, not the control.
  const readOnly = useReadOnly();
  async function open() {
    setError('');
    try {
      const status = await sourceApi<{ refs: { name: string; commit_id: string }[] }>(
        `/repos/${repo}`,
      );
      setHead(status.refs.find((r) => r.name === `refs/heads/${target}`)?.commit_id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const result = await sourceApi(`/repos/${repo}/break-glass`, {
        body: { action, ref: target, commit, expected_old: head, reason },
      });
      setHead(undefined);
      setReason('');
      onDone(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="source-break-glass" aria-label="Break-glass recovery">
      <BreakGlassRecords commit={commit} records={records} />
      {readOnly ? null : head === undefined ? (
        <button type="button" className="quiet" onClick={open}>
          Break glass…
        </button>
      ) : (
        <div className="source-break-glass-confirm">
          <p>
            <strong>
              {action === 'land'
                ? `Land on ${target} without waiting for checks or approvals.`
                : `Revert this commit on ${target} now, without checks.`}
            </strong>{' '}
            Only for recovering when automation is broken. Recorded with your name and reason.
            Current head of {target}: <code>{head ? shortSha(head) : 'none'}</code>.
          </p>
          <textarea
            aria-label="Break-glass reason"
            placeholder="Why automation cannot be used (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="source-actions">
            <button
              type="button"
              className="danger"
              disabled={busy || !reason.trim()}
              onClick={confirm}
            >
              {busy ? 'Recording…' : action === 'land' ? 'Confirm land' : 'Confirm revert'}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setHead(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
