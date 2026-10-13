import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';
import { WorkspaceAllowance } from './WorkspaceAllowance';

export function LegacyReviewApproval({
  goal,
  candidates,
  busy,
  uncertain = false,
  blocker,
  onApprove,
  onClose,
}: {
  goal: string;
  candidates: Record<string, any>[];
  busy: boolean;
  uncertain?: boolean;
  blocker?: string;
  onApprove: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  return (
    <Dialog
      title="Review both results"
      initialFocus="button[type=submit]"
      locked={busy || uncertain}
      onClose={onClose}
    >
      <p>{goal}</p>
      <ol>
        {candidates.map((candidate, index) => (
          <li key={candidate.id}>
            <strong>Result {index + 1}</strong> · exact revision{' '}
            <code>{short(candidate.revision?.commit)}</code>
          </li>
        ))}
      </ol>
      <p>
        Review both results and repair the most promising alternative up to two times if needed.
      </p>
      <p>
        <strong>Reviewer: Auto</strong> · existing checked source is retained; builders are not
        restarted.
      </p>
      <WorkspaceAllowance />
      {(error || blocker) && <p role="alert">{error || blocker}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || (!uncertain && blocker)) return;
          setError('');
          void onApprove()
            .then((approved) => {
              if (approved) onClose();
            })
            .catch((failure) => setError(failure.message));
        }}
      >
        <div className="run-actions">
          <button type="submit" disabled={busy || (!uncertain && !!blocker)}>
            {uncertain ? 'Check review status' : 'Start review'}
          </button>
          <button type="button" className="quiet" disabled={busy || uncertain} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
