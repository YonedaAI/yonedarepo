import { ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { short } from '../../lib/api';
import type { AccountIdentity, Repository } from '../../lib/types';
import { AccountMenu } from './AccountMenu';
import { RepositoryActions } from './RepositoryActions';

export function WorkspaceHeader({
  reviewer = false,
  repository,
  loading,
  onRefresh,
  onDelete,
  authenticated,
  identity,
  onSignIn,
  onSignOut,
  onError,
}: {
  reviewer?: boolean;
  repository?: Repository;
  loading: boolean;
  onRefresh: () => void;
  onDelete: (repository: Repository) => void;
  authenticated: boolean;
  identity: AccountIdentity | null;
  onSignIn: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <header className="workspace-header">
      <div className="workspace-breadcrumb">
        <span>Workspace</span>
        <ChevronRight size={14} />
        <strong>
          <GitBranch size={16} />
          {repository?.name ?? 'Overview'}
        </strong>
      </div>
      <div className="header-actions">
        {repository?.published_commit && (
          <span className="published-revision" title="Canonical published source revision">
            <i />
            Published <code>{short(repository.published_commit)}</code>
          </span>
        )}
        {repository && !reviewer && (
          <RepositoryActions repository={repository} onDelete={onDelete} />
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh workspace"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
        {authenticated ? (
          <AccountMenu identity={identity} onSignOut={onSignOut} onError={onError} />
        ) : (
          <button type="button" className="quiet" disabled={loading} onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
