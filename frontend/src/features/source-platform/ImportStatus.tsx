// What a repository's pages show until its import lands: progress, or why it failed.
import { LoaderCircle } from 'lucide-react';
import type { HistoryFill, HistoryStopped } from '../../../../shared/contracts/repo-status';
import { EmptyState } from '../../components/EmptyState';
import { linkTo, type Navigate } from '../shell/useRoute';
import { describeFailure, Loading } from './SourceStatus';
import type { ImportProgress } from './useImportProgress';

export function ImportStatus({
  repo,
  progress,
  owner,
  navigate,
}: {
  repo: string;
  progress: Exclude<ImportProgress, { phase: 'none' }>;
  /** The viewer may delete the repository, which is how an import is tried again. */
  owner: boolean;
  navigate: Navigate;
}) {
  if (progress.phase === 'checking') return <Loading what="repository" />;
  if (progress.phase === 'running')
    return (
      <EmptyState
        role="status"
        title={
          <>
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
            Importing this repository…
          </>
        }
      >
        {progress.stalled
          ? "Couldn't check on the import just now. It keeps running; still trying."
          : "The code appears here when it's ready. The import keeps running if you leave this page."}
      </EmptyState>
    );
  const reason = progress.reason && `Reason: ${describeFailure(progress.reason).text}`;
  return (
    <EmptyState role="alert" title={progress.title}>
      {reason}
      {reason && owner && <br />}
      {owner && (
        <>
          To try again,{' '}
          <a {...linkTo({ view: 'repo-settings', repo, section: 'delete' }, navigate)}>
            delete this repository
          </a>
          , then add it again from the + menu.
        </>
      )}
    </EmptyState>
  );
}

/** What a repository's pages say above their content while its history fills in behind the
 * files: nothing here may read as a whole history until it is one. */
export function HistoryImportStatus({ progress }: { progress: HistoryFill }) {
  return (
    <div className="import-history" role="status">
      <p>
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
        <strong>
          Importing {progress.recorded} of {progress.total} commits
        </strong>
      </p>
      <p className="source-meta">
        All the files are here. History, blame and search fill in as commits arrive.
      </p>
    </div>
  );
}

/** What they say for good once an imported history ended early. */
export function HistoryStoppedStatus({ stopped }: { stopped: HistoryStopped }) {
  return (
    <div className="import-history" role="status">
      <p>
        <strong>
          Only the newest {stopped.recorded} of {stopped.total} commits were imported.
        </strong>
      </p>
      <p className="source-meta">
        {stopped.reason} The files and new work are not affected; older commits are missing from
        history, blame and search.
      </p>
    </div>
  );
}
