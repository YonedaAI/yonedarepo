// "Fork": a copy of this repository owned by the signed-in account (POST /fork; read here is
// enough). History is shared, not copied, so it is quick; the new fork opens when done.
import { type FormEvent, useState } from 'react';
import { forkRequest } from './forks';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';

export function ForkButton({
  repo,
  name,
  onForked,
}: {
  repo: string;
  /** This repository's name: the fork's default. */
  name?: string;
  onForked: (fork: { id: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [forkName, setForkName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function fork(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const request = forkRequest(repo, forkName);
      const forked = await sourceApi<{ id: string; name: string }>(request.path, {
        body: request.body,
      });
      setOpen(false);
      onForked(forked);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <button type="button" className="quiet" onClick={() => setOpen(true)}>
        Fork
      </button>
    );
  return (
    <form
      className="source-token-form"
      onSubmit={fork}
      aria-label="Fork this repository"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <label className="source-field">
        Fork name
        <input
          value={forkName}
          placeholder={name}
          maxLength={100}
          // biome-ignore lint/a11y/noAutofocus: the form opens because the user asked for it.
          autoFocus
          onChange={(e) => setForkName(e.target.value)}
        />
      </label>
      <div className="source-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Forking…' : 'Fork'}
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <Failure error={error} />}
    </form>
  );
}
