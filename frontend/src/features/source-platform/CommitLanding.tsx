// A commit page's landing panel, driven by the commit's state: landed → where, when and by
// whom, with Revert (and Run checks when the repository has checks); not landed → what
// landing needs and only the actions that apply to this viewer (break glass under "More").
import { useState } from 'react';
import { BreakGlass, BreakGlassRecords } from './BreakGlass';
import {
  type CommitDetail,
  type Conflict,
  ConflictList,
  GateSummary,
  type Landing,
  ReviewButtons,
} from './CommitGates';
import { commitPanel, revertBranch } from './commitPanel';
import { principalName } from './fileActivity';
import { useReadOnly } from './repoAccess';
import type { RepoStatus } from './repoStatus';
import { Failure } from './SourceStatus';
import { type SourceApiError, sourceApi, when } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

/** "Landed on main at v2 · <time> · by <who>": who from the log entry at that version. */
export function LandedLine({ repo, landing }: { repo: string; landing: Landing }) {
  const entry = useSource<{ entries: { version: number; actor: string }[] }>(
    `/repos/${repo}/txlog?after=${landing.version - 1}&limit=1`,
  );
  const actor = entry.data?.entries.find((e) => e.version === landing.version)?.actor;
  return (
    <p className="source-change-banner">
      Landed on {landing.refname.replace(/^refs\/heads\//, '')} at v{landing.version} ·{' '}
      {when(landing.landed_at)}
      {actor && ` · by ${principalName(actor.replace(/^break-glass:/, ''))}`}
      {actor?.startsWith('break-glass:') && ' (break glass)'}
    </p>
  );
}

export function CommitLanding({
  repo,
  detail,
  status,
  username,
  onNavigate,
  onReload,
}: {
  repo: string;
  detail: CommitDetail;
  status?: RepoStatus;
  /** The signed-in account: its own commits are not offered for its approval. */
  username?: string;
  onNavigate: (r: SourceRoute) => void;
  /** The commit and the repository changed (a review, landing or check run). */
  onReload: () => void;
}) {
  const commit = detail.commit;
  // A public reader sees the gates, checks and reviews, never review, land or revert.
  const readOnly = useReadOnly();
  const panel = commitPanel(
    detail,
    readOnly ? undefined : status?.viewer,
    status?.policy,
    username,
  );
  const branches = (status?.refs ?? [])
    .filter((r) => r.name.startsWith('refs/heads/'))
    .map((r) => r.name.slice('refs/heads/'.length));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState('main');
  async function act(label: string, path: string, body: unknown, done: (r: any) => string) {
    setBusy(label);
    setError('');
    setNotice('');
    setConflicts([]);
    try {
      setNotice(done(await sourceApi(`/repos/${repo}${path}`, { body })));
      onReload();
    } catch (e) {
      setError((e as Error).message);
      setConflicts((e as SourceApiError).details?.conflicts ?? []);
    } finally {
      setBusy('');
    }
  }
  async function revert(ref: string) {
    setBusy('revert');
    setError('');
    try {
      const made = await sourceApi(`/repos/${repo}/commits/${commit}/revert`, { body: { ref } });
      onNavigate({ view: 'commit', repo, commit: made.commit });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const runChecks = panel.runChecks && (
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
  );
  return (
    <section className="source-gates" aria-label="Landing gates">
      {panel.state === 'landed' ? (
        <>
          {panel.landings.map((l) => (
            <LandedLine key={l.refname} repo={repo} landing={l} />
          ))}
          <BreakGlassRecords commit={commit} records={detail.break_glass} />
          {(panel.revert || runChecks) && (
            <div className="source-actions">
              {panel.revert && (
                <button
                  type="button"
                  className="quiet"
                  disabled={!!busy}
                  onClick={() => revert(revertBranch(panel.landings))}
                >
                  {busy === 'revert' ? 'Reverting…' : 'Revert'}
                </button>
              )}
              {runChecks}
            </div>
          )}
        </>
      ) : (
        <>
          <GateSummary gates={detail.gates} classes={detail.review_classes} notes={panel.notes} />
          {(panel.review || panel.land || runChecks) && (
            <div className="source-actions">
              {panel.review && (
                <ReviewButtons
                  disabled={!!busy}
                  onReview={(decision, reason) =>
                    act('review', `/commits/${commit}/reviews`, { decision, reason }, () =>
                      decision === 'approve' ? 'Approved.' : 'Rejected.',
                    )
                  }
                />
              )}
              {runChecks}
              {panel.land && (
                <>
                  <label>
                    Branch{' '}
                    <select value={target} onChange={(e) => setTarget(e.target.value)}>
                      {(branches.includes(target) ? branches : [target, ...branches]).map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() =>
                      act('land', '/land', { ref: target, commit }, () => `Landed on ${target}.`)
                    }
                  >
                    {busy === 'land' ? 'Landing…' : `Land on ${target}`}
                  </button>
                </>
              )}
            </div>
          )}
          <BreakGlassRecords commit={commit} records={detail.break_glass} />
          {panel.breakGlass && (
            <details className="source-more">
              <summary>More</summary>
              <BreakGlass
                repo={repo}
                commit={commit}
                target={target}
                landedOn={[]}
                records={[]}
                onDone={(r) => {
                  setNotice(
                    r.already ? 'Already recorded; nothing changed.' : 'Break-glass recorded.',
                  );
                  if (r.commit && r.commit !== commit)
                    onNavigate({ view: 'commit', repo, commit: r.commit });
                  else onReload();
                }}
              />
            </details>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <Failure error={error} />}
      <ConflictList conflicts={conflicts} />
    </section>
  );
}
