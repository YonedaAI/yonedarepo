import type { RunMode } from '../../../../shared/team';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { PublishedRunNotice } from './PublishedRunNotice';
import type { runDraft } from './runDraft';
import { WorkingBranchNotice } from './WorkingBranchNotice';

export function RunSourceNotice({
  snapshot,
  draft,
  updating,
  mode,
  agents,
}: {
  snapshot: Snapshot;
  draft: ReturnType<typeof runDraft>;
  updating: boolean;
  mode: RunMode;
  agents: number;
}) {
  return (
    <>
      {draft.workingBranch && (
        <WorkingBranchNotice
          branch={draft.workingBranch}
          canonical={snapshot.repository.published_commit}
        />
      )}
      {updating && (
        <PublishedRunNotice
          publication={draft.publication}
          contextTotal={draft.inheritedContextTotal}
        />
      )}
      {draft.restartOf && (
        <p className="restart-notice">
          Restarting creates a new run from the current canonical source. The previous run and its
          failure evidence remain in history. Current repository checks apply. Review connections
          and limits before approving.
        </p>
      )}
      <p>
        {mode === 'collaborate'
          ? 'Each agent builds the tasks you assigned in its own sandbox; the platform merges their work on one team branch.'
          : agents === 1
            ? 'Your agent works in an isolated workspace with the approved brief and selected context.'
            : 'Your agents share one source revision, brief and selected context. Each works in an isolated workspace as capacity becomes available.'}{' '}
        Independent checks and your publishing decision still apply. Approval starts paid inference
        using your provider keys.
      </p>
      <p className="subtle">
        Preview availability depends on the recorded evaluation output. Publication requires
        independent checks and a separate recorded decision.
      </p>
      {!draft.workingBranch && (
        <p className="subtle">
          Starting source: <code>{short(snapshot.repository.head_commit)}</code> · current canonical
          revision
        </p>
      )}
    </>
  );
}
