import { Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import type { Repository } from '../../lib/types';

export function DeleteRepositoryDialog({
  repository,
  onClose,
  onDelete,
  onDeleted,
}: {
  repository: Repository;
  onClose: () => void;
  onDelete: (repository: Repository, confirmName: string) => Promise<{ cleanup_pending: boolean }>;
  onDeleted: (result: { cleanup_pending: boolean }) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const description = useId();
  return (
    <Dialog
      title="Delete repository"
      onClose={onClose}
      locked={busy}
      initialFocus='input[name="confirm_name"]'
    >
      <form
        className="delete-repository-form"
        aria-describedby={description}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || name !== repository.name) return;
          setBusy(true);
          setError('');
          try {
            onDeleted(await onDelete(repository, name));
          } catch (failure) {
            setError((failure as Error).message);
            setBusy(false);
          }
        }}
      >
        <p id={description}>
          Delete <strong>{repository.name}</strong> and remove its source, runs, context graph and
          agent access from this workspace. Active work stops and its published website becomes
          unavailable. This action cannot be undone.
        </p>
        <p className="subtle">
          Provider connections stay. Storage cleanup continues in the background.
        </p>
        <label>
          Type <strong>{repository.name}</strong> to confirm
          <input
            name="confirm_name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {busy && <p role="status">Deleting repository and stopping active work…</p>}
        <div className="run-actions">
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger-button"
            disabled={busy || name !== repository.name}
          >
            <Trash2 size={16} />
            {busy ? 'Deleting…' : 'Delete repository'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
