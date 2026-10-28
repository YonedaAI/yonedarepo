// The one page for a repository that is not there for this viewer: deleted, never created or
// outside their access. It replaces the repository's tabs, so the failing reads of every view
// never stack up as separate errors or retries.
import { useEffect, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { onRepoGone } from './sourceApi';

/** The repository status read's codes that mean it is not there for this viewer: GONE (a
 * tombstone), NOT_FOUND (unknown or never initialized) and FORBIDDEN (another workspace's). */
const MISSING = new Set(['GONE', 'NOT_FOUND', 'FORBIDDEN']);
export const repoMissing = (code: string | undefined) => code !== undefined && MISSING.has(code);

/** True once any read under `repo` answers GONE: it was deleted while its page is open. */
export function useRepoGone(repo: string): boolean {
  const [gone, setGone] = useState(false);
  useEffect(
    () =>
      onRepoGone((id) => {
        if (id === repo) setGone(true);
      }),
    [repo],
  );
  return gone;
}

export function RepoNotFound({ navigate, onNew }: { navigate: Navigate; onNew: () => void }) {
  return (
    <section className="repo-page" aria-labelledby="repo-missing-heading">
      <div className="repo-head">
        <h1 id="repo-missing-heading">Repository not found</h1>
      </div>
      <div className="source-empty-state">
        <p>This repository doesn't exist or was deleted, or you don't have access.</p>
        <p>
          <a {...linkTo({ view: 'home' }, navigate)}>Repositories</a>
          {' · '}
          <button type="button" className="quiet" onClick={onNew}>
            New repository
          </button>
        </p>
      </div>
    </section>
  );
}
