// The one page for a repository that is not there for this viewer: deleted, never created,
// outside their access, or private (the server does not say which). It replaces the
// repository's tabs, so the failing reads of every view never stack up as separate errors or
// retries. Signed out, the way in is to sign in; anyone may browse public repositories.
import { useEffect, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
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
  useEffect(() => {
    return onRepoGone((id) => {
      if (id === repo) setGone(true);
    });
  }, [repo]);
  return gone;
}

export function RepoNotFound({
  navigate,
  authenticated = true,
  onSignIn,
}: {
  navigate: Navigate;
  /** Whether an account is signed in (a signed-out visitor reads public repositories only). */
  authenticated?: boolean;
  onSignIn?: () => void;
}) {
  return (
    <section className="repo-page" aria-labelledby="repo-missing-heading">
      <EmptyState
        level={1}
        id="repo-missing-heading"
        title="Repository not found"
        action={
          authenticated ? (
            <a className="button-link" {...linkTo({ view: 'home' }, navigate)}>
              Your repositories
            </a>
          ) : onSignIn ? (
            <button type="button" onClick={onSignIn}>
              Sign in
            </button>
          ) : (
            <a className="button-link" {...linkTo({ view: 'explore' }, navigate)}>
              Browse public repositories
            </a>
          )
        }
      >
        It doesn't exist, was deleted, or is private.
        {authenticated
          ? ' If it is private, ask its owner to add you.'
          : ' If you are a member, sign in to open it.'}
      </EmptyState>
    </section>
  );
}
