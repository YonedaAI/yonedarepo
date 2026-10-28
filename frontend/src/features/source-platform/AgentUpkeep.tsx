// Agents → Pins and Bisects: commits pinned against vacuum, and bisects the platform runs
// (the first commit on a branch that breaks a policy check). Both are started by agents
// through MCP (`git_pin`, `git_bisect`) or the API; these pages only show them.
import { linkTo, type Navigate } from '../shell/useRoute';
import { type Bisect, type Pin, recorder, shortRef } from './agentModel';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { useSource } from './useSource';

export function AgentPins({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const loaded = useSource<{ pins: Pin[] }>(`/repos/${repo}/pins`);
  if (loaded.loading && !loaded.data) return <Loading what="pins" />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} />;
  const pins = loaded.data?.pins ?? [];
  return (
    <section aria-labelledby="pins-heading">
      <h2 id="pins-heading">Pinned commits</h2>
      {pins.length === 0 ? (
        <div className="source-empty-state">
          <p>
            <strong>No pinned commits.</strong> A pin keeps a commit's objects from vacuum, for
            example while a long job reads it. Agents pin with MCP <code>git_pin</code> or{' '}
            <code>POST /commits/&lt;sha&gt;/pin</code>.
          </p>
        </div>
      ) : (
        <ul className="agent-list" aria-label="Pins">
          {pins.map((p) => (
            <li key={p.commit}>
              <a {...linkTo({ view: 'commit', repo, commit: p.commit }, navigate)}>
                <code>{shortSha(p.commit)}</code> {p.subject}
              </a>
              <span className="source-meta">
                {p.reason} · {recorder(p.pinned_by)} · {when(p.pinned_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BisectRow({ repo, b, navigate }: { repo: string; b: Bisect; navigate: Navigate }) {
  const commit = (sha: string) => (
    <a {...linkTo({ view: 'commit', repo, commit: sha }, navigate)}>
      <code>{shortSha(sha)}</code>
    </a>
  );
  return (
    <li>
      <span className={`chip agent-bisect-${b.status}`}>{b.status}</span> <strong>{b.check}</strong>{' '}
      on <code>{shortRef(b.ref)}</code>
      <span className="source-meta">
        {b.candidates} candidate{b.candidates === 1 ? '' : 's'}
        {b.bad && <> up to {commit(b.bad)}</>} · {recorder(b.requested_by)} · {when(b.created_at)}
      </span>
      {b.status === 'found' && b.result?.first_bad && (
        <span>First bad commit: {commit(b.result.first_bad)}</span>
      )}
      {b.status === 'running' && b.testing && (
        <span className="source-meta">
          Testing {commit(b.testing)}; {b.remaining} left in range.
        </span>
      )}
    </li>
  );
}

export function AgentBisects({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const loaded = useSource<{ bisects: Bisect[] }>(`/repos/${repo}/bisect`);
  if (loaded.loading && !loaded.data) return <Loading what="bisects" />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} />;
  const bisects = loaded.data?.bisects ?? [];
  return (
    <section aria-labelledby="bisects-heading">
      <h2 id="bisects-heading">Bisects</h2>
      {bisects.length === 0 ? (
        <div className="source-empty-state">
          <p>
            <strong>No bisects yet.</strong> A bisect finds the first commit on a branch that breaks
            a policy check; the platform runs the check on midpoints. Agents start one with MCP{' '}
            <code>git_bisect</code> (good, bad, check).
          </p>
        </div>
      ) : (
        <ul className="agent-list" aria-label="Bisects">
          {bisects.map((b) => (
            <BisectRow key={b.id} repo={repo} b={b} navigate={navigate} />
          ))}
        </ul>
      )}
    </section>
  );
}
