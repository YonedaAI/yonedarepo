// What a repository's Overview says of it in one row: who can read it, where it was forked from,
// the version of main, what landing needs, and Fork. Each links to where it is changed.
import { linkTo, type Navigate } from '../shell/useRoute';
import { ForkButton } from './ForkButton';
import { PublicBadge } from './PublicBadge';
import { isPublic } from './repoAccess';
import type { RepoStatus } from './repoStatus';
import { StatusChips } from './StatusChips';

export function RepoFacts({
  repo,
  status,
  owner,
  readOnly,
  canFork,
  navigate,
}: {
  repo: string;
  status: RepoStatus;
  owner: boolean;
  readOnly: boolean;
  canFork: boolean;
  navigate: Navigate;
}) {
  return (
    <div className="repo-facts">
      {isPublic(status.visibility) && <PublicBadge />}
      {status.parent && (
        <p className="source-meta">
          Forked from{' '}
          <a
            {...linkTo(
              { view: 'files', repo: status.parent.repo, path: '', ref: 'main' },
              navigate,
            )}
          >
            {status.parent.repo}
          </a>{' '}
          at v{status.parent.version}
        </p>
      )}
      <StatusChips
        repo={repo}
        status={status}
        owner={owner}
        readOnly={readOnly}
        navigate={navigate}
      />
      {canFork && (
        <ForkButton
          repo={repo}
          name={status.name}
          onForked={(fork) => navigate({ view: 'files', repo: fork.id, path: '', ref: 'main' })}
        />
      )}
    </div>
  );
}
