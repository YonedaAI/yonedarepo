// The one page for a repository that is not there for this viewer: deleted, never created,
// outside their access, or private (the server does not say which). It replaces the
// repository's tabs, so the failing reads of every view never stack up as separate errors or
// retries. Signed out, the way in is to sign in; anyone may browse public repositories.
import { Compass, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { onRepoGone } from './sourceApi';

/** The repository status read's codes that mean it is not there for this viewer: GONE (a
 * tombstone), NOT_FOUND (unknown, never initialized, or private to others) and FORBIDDEN
 * (another workspace's). */
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

export function RepoNotFound({
  navigate,
  onNew,
  authenticated = true,
  onSignIn,
}: {
  navigate: Navigate;
  /** Offered to a signed-in viewer: create a repository instead. */
  onNew?: () => void;
  /** Whether an account is signed in (a signed-out visitor reads public repositories only). */
  authenticated?: boolean;
  onSignIn?: () => void;
}) {
  return (
    <section className="repo-page" aria-labelledby="repo-missing-heading">
      <div className="repo-head">
        <h1 id="repo-missing-heading">Repository not found (or it is private)</h1>
      </div>
      <div className="source-empty-state">
        <p>
          This repository doesn't exist or was deleted, or you don't have access.
          {authenticated
            ? ' If it is private, ask its owner to add you as a member.'
            : ' If it is private and you are a member, sign in to open it.'}
        </p>
        <p className="source-actions">
          {!authenticated && onSignIn && (
            <button type="button" onClick={onSignIn}>
              <LogIn size={16} aria-hidden="true" />
              Sign in
            </button>
          )}
          {authenticated && <a {...linkTo({ view: 'home' }, navigate)}>Repositories</a>}
          <a className="repo-not-found-link" {...linkTo({ view: 'explore' }, navigate)}>
            <Compass size={16} aria-hidden="true" />
            Browse public repositories
          </a>
          {authenticated && onNew && (
            <button type="button" className="quiet" onClick={onNew}>
              New repository
            </button>
          )}
        </p>
      </div>
    </section>
  );
}
