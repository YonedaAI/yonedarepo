// Agents → Kept commits and Find a breaking commit: commits pinned against cleanup (vacuum),
// and bisects the platform runs (the first commit on a branch that breaks a policy check).
// Both are started by agents through MCP (`git_pin`, `git_bisect`) or the API; these pages
// only show them.
import { linkTo, type Navigate } from '../shell/useRoute';
import { type Bisect, type Pin, shortRef } from './agentModel';
import { usePeople } from './people';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { useSource } from './useSource';

export function AgentPins({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const people = usePeople();
  const loaded = useSource<{ pins: Pin[] }>(`/repos/${repo}/pins`);
  if (loaded.loading && !loaded.data) return <Loading what="kept commits" />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} />;
  const pins = loaded.data?.pins ?? [];
  return (
    <section aria-labelledby="pins-heading">
      <h2 id="pins-heading">Kept commits</h2>
      <p className="agent-subtitle">Commits kept from cleanup, even after their branch is gone.</p>
      {pins.length === 0 ? (
        <div className="source-empty-state">
          <p>
            <strong>No kept commits.</strong> Keeping a commit stops cleanup from deleting it, even
            after its branch is gone, for example a commit a review or a test run still needs.
          </p>
          <p className="source-meta">
            Agents keep one with <code>git_pin</code>.
          </p>
        </div>
      ) : (
        <ul className="agent-list" aria-label="Kept commits">
          {pins.map((p) => (
            <li key={p.commit}>
              <a {...linkTo({ view: 'commit', repo, commit: p.commit }, navigate)}>
                <code>{shortSha(p.commit)}</code> {p.subject}
              </a>
              <span className="source-meta">
                kept by {people.principal(p.pinned_by)}
                {p.reason ? ` because ${p.reason}` : ''} · {when(p.pinned_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS: Record<Bisect['status'], string> = {
  running: 'searching',
  found: 'found',
  failed: 'failed',
};

function BisectRow({ repo, b, navigate }: { repo: string; b: Bisect; navigate: Navigate }) {
  const people = usePeople();
  const commit = (sha: string) => (
    <a {...linkTo({ view: 'commit', repo, commit: sha }, navigate)}>
      <code>{shortSha(sha)}</code>
    </a>
  );
  return (
    <li>
      <span className={`chip agent-bisect-${b.status}`}>{STATUS[b.status]}</span>{' '}
      <strong>{b.check}</strong> on <code>{shortRef(b.ref)}</code>
      <span className="source-meta">
        {b.candidates} candidate{b.candidates === 1 ? '' : 's'}
        {b.bad && <> up to {commit(b.bad)}</>} · {people.principal(b.requested_by)} ·{' '}
        {when(b.created_at)}
      </span>
      {b.status === 'found' && b.result?.first_bad && (
        <span>First breaking commit: {commit(b.result.first_bad)}</span>
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
  if (loaded.loading && !loaded.data) return <Loading what="searches" />;
  if (loaded.error) return <Failure error={loaded.error} onRetry={loaded.reload} />;
  const bisects = loaded.data?.bisects ?? [];
  return (
    <section aria-labelledby="bisects-heading">
      <h2 id="bisects-heading">Find a breaking commit</h2>
      <p className="agent-subtitle">Searches for the first commit that broke a check.</p>
      {bisects.length === 0 ? (
        <div className="source-empty-state">
          <p>
            <strong>No searches yet.</strong> Give one commit that works and one that doesn't.
            YonedaRepo runs your check on the commits in between, halving the range each time, until
            it finds the first one that broke it.
          </p>
          <p className="source-meta">
            Start one with <code>git_bisect</code>.
          </p>
        </div>
      ) : (
        <ul className="agent-list" aria-label="Searches for a breaking commit">
          {bisects.map((b) => (
            <BisectRow key={b.id} repo={repo} b={b} navigate={navigate} />
          ))}
        </ul>
      )}
    </section>
  );
}
