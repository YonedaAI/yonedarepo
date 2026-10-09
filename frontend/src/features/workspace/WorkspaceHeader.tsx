import { ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { short } from '../../lib/api';
import type { Repository } from '../../lib/types';
import { RepositoryActions } from './RepositoryActions';

export function WorkspaceHeader({
  repository,
  loading,
  onRefresh,
  onDelete,
}: {
  repository?: Repository;
  loading: boolean;
  onRefresh: () => void;
  onDelete: (repository: Repository) => void;
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
        {repository && <RepositoryActions repository={repository} onDelete={onDelete} />}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh workspace"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>
    </header>
  );
}
