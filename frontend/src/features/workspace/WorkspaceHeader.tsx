import { ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import type { AccountIdentity } from '../../lib/types';
import { linkTo, type Navigate } from '../shell/useRoute';
import { AccountMenu } from './AccountMenu';

/** The shell's header: where you are, refresh and the account menu. */
export function WorkspaceHeader({
  title,
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
