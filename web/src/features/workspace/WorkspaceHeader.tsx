import { ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { short } from '../../lib/api';
import type { Repository } from '../../lib/types';

export function WorkspaceHeader({
  repository,
  loading,
  onRefresh,
}: {
  repository?: Repository;
  loading: boolean;
  onRefresh: () => void;
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
        {repository && (
          <span className="published-revision" title="Canonical published source revision">
            <i />
            Published <code>{short(repository.published_commit)}</code>
          </span>
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
      </div>
    </header>
  );
}
