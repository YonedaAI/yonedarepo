// The connected account's repositories in the import dialog: picking one starts its import, and
// one already added opens it. Which repositories are listed is chosen on GitHub's install page, for
// an account or an organization alike, so the list ends with the way there.
import { ADD_CONNECTION_PATH, type GitHubRepository } from '../source-platform/importModel';

export function GitHubRepoList({
  repositories,
  matching,
  addedOf = () => undefined,
  busy,
  onPick,
  onOpen = () => {},
  onOpenGitHub,
}: {
  repositories: GitHubRepository[];
  /** Those the field's text matches. */
  matching: GitHubRepository[];
  /** The repository here that a GitHub repository is already added as. */
  addedOf?: (fullName: string) => string | undefined;
  busy: boolean;
  onPick: (fullName: string) => void;
  onOpen?: (repo: string) => void;
  onOpenGitHub: () => void;
}) {
  return (
    <>
      {matching.length > 0 && (
        <ul className="github-repo-list" aria-label="Your GitHub repositories">
          {matching.map((r) => {
            const added = addedOf(r.full_name);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => (added ? onOpen(added) : onPick(r.full_name))}
                >
                  <span>{r.full_name}</span>
                  <small>{added ? 'Added' : r.private ? 'Private' : 'Public'}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="source-meta github-repo-more">
        {repositories.length === 0 && 'No repositories shared yet. '}
        <a href={ADD_CONNECTION_PATH} target="_blank" rel="noreferrer" onClick={onOpenGitHub}>
          Add another repository
          <span className="sr-only"> (opens GitHub in a new tab)</span>
        </a>
      </p>
    </>
  );
}
