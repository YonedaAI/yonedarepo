import { useState } from 'react';
import { BreakGlass } from './BreakGlass';
import { CommitDiff } from './CommitDiff';
import {
  type CommitDetail,
  type Conflict,
  ConflictList,
  GateSummary,
  ReviewButtons,
} from './CommitGates';
import { CommitRepairs } from './CommitRepairs';
import { CommitSessions } from './CommitSessions';
import { Failure, Loading } from './SourceStatus';
import { type SourceApiError, shortSha, sourceApi, when } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

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
  const detail = useSource<CommitDetail>(`/repos/${repo}/commits/${commit}`);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [notice, setNotice] = useState('');
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
        <GateSummary gates={gates} classes={d.review_classes} landings={d.landings} />
        <div className="source-actions">
          <ReviewButtons
            disabled={!!busy}
            onReview={(decision, reason) =>
              act(
                decision,
                `/commits/${commit}/reviews`,
                { decision, reason },
                decision === 'approve' ? 'Approved.' : 'Rejected.',
              )
            }
          />
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
        <BreakGlass
          repo={repo}
          commit={commit}
          target={target}
          landedOn={d.landings.map((l) => l.refname)}
          records={d.break_glass}
          onDone={(r) => {
            setNotice(r.already ? 'Already recorded; nothing changed.' : 'Break-glass recorded.');
            if (r.commit && r.commit !== commit)
              onNavigate({ view: 'commit', repo, commit: r.commit });
            else detail.reload();
            onChanged();
          }}
        />
        {notice && <p role="status">{notice}</p>}
        {error && <Failure error={error} />}
        <ConflictList conflicts={conflicts} />
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
      <CommitRepairs repo={repo} repairs={d.repairs} onNavigate={onNavigate} />
      <CommitSessions repo={repo} commit={commit} navigate={onNavigate} />
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
        <CommitDiff
          repo={repo}
          commit={commit}
          classes={Object.fromEntries(
            (d.review_classes?.files ?? []).map((f) => [f.path, f.class]),
          )}
        />
      </section>
    </article>
  );
}
