// "Fork": a copy of this repository owned by the signed-in account or an organization it
// owns (POST /fork; read here is enough). History is shared, not copied, so it is quick;
// the new fork opens when done.
import { type FormEvent, useState } from 'react';
import { forkRequest } from './forks';
import { type OrgSummary, ownerOptions } from './orgModel';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { useSource } from './useSource';

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
  const [owner, setOwner] = useState('');
  // The caller's orgs, read only once the form opens: owned ones may own the fork.
  const orgs = useSource<{ orgs: OrgSummary[] }>(open ? '/orgs' : null);
  const owners = ownerOptions(undefined, orgs.data?.orgs ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function fork(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const request = forkRequest(repo, forkName, owner);
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
      {owners.length > 1 && (
        <label className="source-field">
          Owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {owners.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
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
