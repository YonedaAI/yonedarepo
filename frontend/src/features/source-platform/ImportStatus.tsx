// What a repository's pages show until its import lands: progress, or why it failed.
import { LoaderCircle } from 'lucide-react';
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
      <div className="source-empty-state import-status" role="status">
        <p>
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          <strong>Importing this repository…</strong>
        </p>
        <p className="source-meta">
          {progress.stalled
            ? "Couldn't check on the import just now. It keeps running; still trying."
            : "The code appears here when it's ready. A large repository can take several minutes; the import keeps running if you leave this page."}
        </p>
      </div>
    );
  return (
    <div className="source-empty-state import-status import-failed" role="alert">
      <p>
        <strong>{progress.title}</strong>
      </p>
      {progress.reason && (
        <p className="source-meta">Reason: {describeFailure(progress.reason).text}</p>
      )}
      {owner && (
        <p className="source-meta">
          To try again,{' '}
          <a {...linkTo({ view: 'repo-settings', repo, section: 'delete' }, navigate)}>
            delete this repository
          </a>
          , then add it again from the + menu.
        </p>
      )}
    </div>
  );
}
