// Deleting a repository for good, ahead of its window (`POST /repos/:id/purge`): one row's Delete
// and Delete all share this dialog. The server decides who may and refuses a legal hold; this
// asks once, goes through them in turn, and says what it couldn't delete.
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import type { DeletedRepo } from './RecentlyDeleted';
import { describeFailure, Failure } from './SourceStatus';
import { SourceApiError, sourceApi } from './sourceApi';

export type NotDeleted = { repo: DeletedRepo; reason: string };

const purgeRepo = (repo: DeletedRepo) => sourceApi(`/repos/${repo.id}/purge`, { body: {} });

/** `purge` for each of `repos` in turn, `onProgress` counting them, one that fails not stopping
 * the rest. Answers those it could not delete. One already gone is what was asked for. */
export async function purgeEach(
  repos: DeletedRepo[],
  purge: (repo: DeletedRepo) => Promise<unknown>,
  onProgress: (done: number) => void,
) {
  const failed: NotDeleted[] = [];
  for (const [index, repo] of repos.entries()) {
    try {
      await purge(repo);
    } catch (e) {
      if (!(e instanceof SourceApiError && e.code === 'GONE'))
        failed.push({ repo, reason: (e as Error).message });
    }
    onProgress(index + 1);
  }
  return failed;
}

function Refused({ failed, total }: { failed: NotDeleted[]; total: number }) {
  if (total === 1) return <Failure error={failed[0].reason} />;
  return (
    <div role="alert" className="source-error deleted-refused">
      <p>
        Deleted {total - failed.length} of {total}. These couldn't be deleted:
      </p>
      <ul>
        {failed.map(({ repo, reason }) => (
          <li key={repo.id}>
            <strong>{repo.name}</strong>: {describeFailure(reason).text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function confirmLabel(repos: DeletedRepo[]) {
  return repos.length > 1 ? `Delete all ${repos.length}` : 'Delete permanently';
}

export function PurgeDialog({
  repos,
  purge = purgeRepo,
  onPurged,
  onClose,
}: {
  repos: DeletedRepo[];
  purge?: (repo: DeletedRepo) => Promise<unknown>;
  /** Some are gone: the list reads again. */
  onPurged: () => void;
  onClose: () => void;
}) {
  const [left, setLeft] = useState(repos);
  const [done, setDone] = useState<number | null>(null);
  const [failed, setFailed] = useState<NotDeleted[]>([]);
  const running = done !== null;
  const many = repos.length > 1;
  async function run() {
    setDone(0);
    setFailed([]);
    const refused = await purgeEach(left, purge, setDone);
    setDone(null);
    onPurged();
    if (refused.length === 0) return onClose();
    setFailed(refused);
    setLeft(refused.map((f) => f.repo));
  }
  const warning = `This can't be undone. Restore won't bring ${many ? 'them' : 'it'} back.`;
  const progress = `Deleting ${Math.min((done ?? 0) + 1, left.length)} of ${left.length}…`;
  return (
    <Dialog
      title={
        many
          ? `Delete all ${repos.length} repositories permanently?`
          : `Delete ${repos[0].name} permanently?`
      }
      onClose={onClose}
      locked={running}
      initialFocus="#purge-cancel"
    >
      <p role="status">{running ? progress : warning}</p>
      {failed.length > 0 && <Refused failed={failed} total={repos.length} />}
      <div className="run-actions">
        <button type="button" className="danger" disabled={running} onClick={() => void run()}>
          {running ? 'Deleting…' : failed.length > 0 ? 'Try again' : confirmLabel(repos)}
        </button>
        <button
          type="button"
          id="purge-cancel"
          className="quiet"
          disabled={running}
          onClick={onClose}
        >
          {failed.length > 0 ? 'Close' : 'Cancel'}
        </button>
      </div>
    </Dialog>
  );
}
