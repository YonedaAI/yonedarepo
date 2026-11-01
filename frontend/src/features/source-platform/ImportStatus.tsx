// What a repository's pages show until its import lands: progress, or why it failed.
import { LoaderCircle } from 'lucide-react';
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
