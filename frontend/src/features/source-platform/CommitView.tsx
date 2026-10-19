import { useState } from 'react';
import { CommitDiff } from './CommitDiff';
import { Failure, Loading } from './SourceStatus';
import { type SourceApiError, shortSha, sourceApi, when } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type Detail = {
  commit: string;
  message: string;
  principal: string;
  parents: string[];
  read_set: string[];
  checks: { name: string; status: string; principal: string; recorded_at: number }[];
  check_runs: { id: string; name: string; status: string; epoch: number }[];
  reviews: { principal: string; decision: string; reason?: string; recorded_at: number }[];
  landings: { refname: string; version: number; landed_at: number }[];
  repairs: {
    refname: string;
    check_name: string;
    repair_commit: string | null;
    error: string | null;
  }[];
  gates: {
    ready: boolean;
    approvals: number;
    approvals_required: number;
    rejected: boolean;
    missing_checks: string[];
    failing_checks: string[];
  };
};

export function CommitView({
  repo,
  commit,
  onNavigate,
  onChanged,
}: {
  repo: string;
  commit: string;
  onNavigate: (r: SourceRoute) => void;
  onChanged: () => void;
}) {
  const detail = useSource<Detail>(`/repos/${repo}/commits/${commit}`);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<{ path: string; kind: string; marked?: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('main');
  async function act(
    label: string,
    path: string,
    body: unknown,
    done: string | ((r: any) => string),
  ) {
    setBusy(label);
    setError('');
    setNotice('');
    setConflicts([]);
    try {
      const result = await sourceApi(`/repos/${repo}${path}`, { body });
      setNotice(typeof done === 'string' ? done : done(result));
      detail.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setConflicts((e as SourceApiError).details?.conflicts ?? []);
    } finally {
      setBusy('');
    }
  }
  if (detail.error) return <Failure error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading what="commit" />;
  const d = detail.data;
  const gates = d.gates;
  return (
    <article className="source-commit" aria-label={`Commit ${shortSha(d.commit)}`}>
      <header>
        <h2>{d.message.split('\n')[0]}</h2>
        <p className="source-meta">
          <code>{d.commit}</code> by {d.principal}
          {d.parents.map((p) => (
            <span key={p}>
              {' · parent '}
              <a
                href={`/source/${repo}/commit/${p}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate({ view: 'commit', repo, commit: p });
                }}
              >
                <code>{shortSha(p)}</code>
              </a>
            </span>
          ))}
        </p>
        {d.read_set.length > 0 && (
          <p className="source-meta">Declared read set: {d.read_set.join(', ')}</p>
        )}
      </header>
      <section className="source-gates" aria-label="Landing gates">
        <h3>{gates.ready ? 'Ready to land' : 'Not ready to land'}</h3>
        <ul>
          <li>
            Approvals {gates.approvals}/{gates.approvals_required}
            {gates.rejected && ' · rejected'}
          </li>
          {gates.missing_checks.length > 0 && (
            <li>Waiting for checks: {gates.missing_checks.join(', ')}</li>
          )}
          {gates.failing_checks.length > 0 && (
            <li>Failing checks: {gates.failing_checks.join(', ')}</li>
          )}
          {d.landings.map((l) => (
            <li key={l.refname}>
              Landed on {l.refname.replace(/^refs\/heads\//, '')} at v{l.version} ·{' '}
              {when(l.landed_at)}
            </li>
          ))}
        </ul>
        <div className="source-actions">
          <button
            type="button"
            disabled={!!busy}
            onClick={() =>
              act('approve', `/commits/${commit}/reviews`, { decision: 'approve' }, 'Approved.')
            }
          >
            Approve
          </button>
          <input
            aria-label="Rejection reason"
            placeholder="Reason to reject"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="danger"
            disabled={!!busy || !reason.trim()}
            onClick={() =>
              act(
                'reject',
                `/commits/${commit}/reviews`,
                { decision: 'reject', reason },
                'Rejected.',
              )
            }
          >
            Reject
          </button>
          <button
            type="button"
            className="quiet"
            disabled={!!busy}
            onClick={() =>
              act('checks', `/commits/${commit}/check-runs`, {}, (r) =>
                r.runs?.length
                  ? `Checks: ${r.runs.map((x: any) => `${x.name} ${x.status}`).join(', ')}.`
                  : 'This repository has no check runners.',
              )
            }
          >
            Run checks
          </button>
          <button
            type="button"
            className="quiet"
            disabled={!!busy}
            onClick={async () => {
              setBusy('revert');
              setError('');
              try {
                const made = await sourceApi(`/repos/${repo}/commits/${commit}/revert`, {
                  body: { ref: target },
                });
                onNavigate({ view: 'commit', repo, commit: made.commit });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy('');
              }
            }}
          >
            Revert
          </button>
          <input
            aria-label="Branch to land on"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button
            type="button"
            disabled={!!busy || !gates.ready}
            onClick={() => act('land', '/land', { ref: target, commit }, `Landed on ${target}.`)}
          >
            {busy === 'land' ? 'Landing…' : 'Land'}
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && <Failure error={error} />}
        {conflicts.map((c) => (
          <section key={c.path} className="source-file" aria-label={`Conflict in ${c.path}`}>
            <header>
              <code>{c.path}</code>
              <span>{c.kind.replace('_', '/')} conflict: resolve in a new commit</span>
            </header>
            {c.marked && <pre>{c.marked}</pre>}
          </section>
        ))}
      </section>
      <section aria-label="Checks">
        <h3>Checks</h3>
        {d.checks.length === 0 && d.check_runs.length === 0 && (
          <p className="source-empty">No checks recorded.</p>
        )}
        <ul className="source-checks">
          {d.checks.map((c) => (
            <li key={c.name} className={`source-check-${c.status}`}>
              {c.name}: {c.status} · {c.principal} · {when(c.recorded_at)}
            </li>
          ))}
          {d.check_runs
            .filter(
              (r) => r.status === 'queued' || r.status === 'running' || r.status === 'errored',
            )
            .map((r) => (
              <li key={r.id}>
                {r.name}: run {r.status}
                {r.epoch > 0 && ` (attempt ${r.epoch})`}
              </li>
            ))}
        </ul>
      </section>
      {d.repairs.length > 0 && (
        <section aria-label="Repairs">
          <h3>Post-land repairs</h3>
          <ul>
            {d.repairs.map((r) => (
              <li key={`${r.refname}:${r.check_name}`}>
                {r.check_name} failed after landing on {r.refname.replace(/^refs\/heads\//, '')}:{' '}
                {r.repair_commit ? (
                  <a
                    href={`/source/${repo}/commit/${r.repair_commit}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate({ view: 'commit', repo, commit: r.repair_commit as string });
                    }}
                  >
                    revert proposed <code>{shortSha(r.repair_commit)}</code>
                  </a>
                ) : (
                  `no automatic repair (${r.error})`
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Reviews">
        <h3>Reviews</h3>
        {d.reviews.length === 0 && <p className="source-empty">No reviews yet.</p>}
        <ul>
          {d.reviews.map((r) => (
            <li key={r.principal}>
              {r.principal}: {r.decision}
              {r.reason && ` — ${r.reason}`} · {when(r.recorded_at)}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Changes">
        <h3>Changes</h3>
        <CommitDiff repo={repo} commit={commit} />
      </section>
    </article>
  );
}
