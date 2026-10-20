import { shortSha } from './sourceApi';
import type { SourceRoute } from './sourceRoute';

export type Repair = {
  refname: string;
  check_name: string;
  repair_commit: string | null;
  error: string | null;
};

/** Checks that failed after landing, with the revert the platform proposed for each. */
export function CommitRepairs({
  repo,
  repairs,
  onNavigate,
}: {
  repo: string;
  repairs: Repair[];
  onNavigate: (r: SourceRoute) => void;
}) {
  if (repairs.length === 0) return null;
  return (
    <section aria-label="Repairs">
      <h3>Post-land repairs</h3>
      <ul>
        {repairs.map((r) => (
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
  );
}
