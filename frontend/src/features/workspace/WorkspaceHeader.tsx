import { ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { short } from '../../lib/api';
import type { AccountIdentity, Repository } from '../../lib/types';
import { linkTo, type Navigate } from '../shell/useRoute';
import { AccountMenu } from './AccountMenu';

/** The shell's header: where you are, the current repository's published head, refresh and
 * the account menu. */
export function WorkspaceHeader({
  title,
  project,
  loading,
  onRefresh,
  authenticated,
  identity,
  navigate = () => {},
  onConnect,
  onSignIn,
  onSignOut,
  onError,
}: {
  /** The current page or repository; the breadcrumb ends here. */
  title: string;
  /** The current repository's agent project, whose published head the header shows. */
  project?: Repository;
  loading: boolean;
  onRefresh: () => void;
  authenticated: boolean;
  identity: AccountIdentity | null;
  navigate?: Navigate;
  onConnect?: () => void;
  onSignIn: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <header className="workspace-header">
      <div className="workspace-breadcrumb">
        <a {...linkTo({ view: 'home' }, navigate)}>Repositories</a>
        <ChevronRight size={14} aria-hidden="true" />
        <strong>
          <GitBranch size={16} aria-hidden="true" />
          {title}
        </strong>
      </div>
      <div className="header-actions">
        {project?.published_commit && (
          <span className="published-revision" title="Canonical published source revision">
            <i />
            Published <code>{short(project.published_commit)}</code>
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={`Refresh ${title}`}
          title="Refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
        {authenticated ? (
          <AccountMenu
            identity={identity}
            navigate={navigate}
            onConnect={onConnect}
            onSignOut={onSignOut}
            onError={onError}
          />
        ) : (
          <button type="button" className="quiet" disabled={loading} onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
