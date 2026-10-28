// A repository page the server answers 404 for: no such repository, or a private one the
// visitor may not read (the server does not say which). Signed out, the way in is to sign in.
import { Compass, LogIn } from 'lucide-react';
import { linkTo, type Navigate } from '../shell/useRoute';

export function RepoNotFound({
  authenticated,
  onSignIn,
  navigate,
}: {
  authenticated: boolean;
  onSignIn?: () => void;
  navigate: Navigate;
}) {
  return (
    <section className="repo-not-found" aria-labelledby="not-found-heading">
      <h1 id="not-found-heading">Repository not found (or it is private)</h1>
      <p>
        {authenticated
          ? 'There is no repository here that this account can read. Ask its owner to add you as a member.'
          : 'There is no public repository here. If it is private and you are a member, sign in to open it.'}
      </p>
      <div className="source-actions">
        {!authenticated && onSignIn && (
          <button type="button" onClick={onSignIn}>
            <LogIn size={16} aria-hidden="true" />
            Sign in
          </button>
        )}
        <a className="repo-not-found-link" {...linkTo({ view: 'explore' }, navigate)}>
          <Compass size={16} aria-hidden="true" />
          Browse public repositories
        </a>
      </div>
    </section>
  );
}
