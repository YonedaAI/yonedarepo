import type { Navigate } from '../shell/useRoute';
import { changeSessionsPath, groupByCommit, type SessionList } from './agentModel';
import { SessionItem } from './CommitSessions';
import { shortSha } from './sourceApi';
import { useSource } from './useSource';

/** The coding sessions behind every commit a change introduces (its head back to the merge
 * base with main), grouped by commit, the commit with the newest session first. */
export function ChangeSessions({
  repo,
  head,
  base,
  navigate,
  onCommit,
}: {
  repo: string;
  head: string;
  base: string | null;
  navigate: Navigate;
  onCommit?: (sha: string) => void;
}) {
  const loaded = useSource<SessionList>(changeSessionsPath(repo, head, base));
  const groups = groupByCommit(loaded.data?.sessions ?? []);
  return (
    <section aria-labelledby="change-sessions-heading">
      <h3 id="change-sessions-heading">Sessions behind this change</h3>
      {loaded.loading && !loaded.data && <p className="source-empty">Loading sessions…</p>}
      {loaded.error && <p className="source-empty">Sessions unavailable: {loaded.error}</p>}
      {loaded.data && groups.length === 0 && (
        <p className="source-empty">No session recorded for this change&apos;s commits.</p>
      )}
      {groups.map((g) => (
        <div key={g.commit}>
          <h4>
            <a
              href={`#${g.commit}`}
              onClick={(e) => {
                e.preventDefault();
                onCommit?.(g.commit);
              }}
            >
              <code>{shortSha(g.commit)}</code>
            </a>{' '}
            {g.subject}
          </h4>
          <ul>
            {g.records.map((s) => (
              <SessionItem key={s.id} repo={repo} session={s} navigate={navigate} />
            ))}
          </ul>
        </div>
      ))}
      {(loaded.data?.next || loaded.data?.branch_scan_truncated) && (
        <p className="source-meta">
          Showing the newest sessions only: there are more than one page holds.
        </p>
      )}
    </section>
  );
}
