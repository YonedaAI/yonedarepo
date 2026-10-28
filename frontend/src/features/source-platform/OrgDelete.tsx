// An owner retires an organization (`DELETE /orgs/:org?confirm=<org>`), typing its name to
// confirm. The server refuses (409) while the org still owns repositories; that answer is
// shown here with the next step.
import { type FormEvent, useState } from 'react';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';

export const orgDeletePath = (org: string, typed: string) =>
  `/orgs/${encodeURIComponent(org)}?confirm=${encodeURIComponent(typed)}`;

export function DeleteOrganization({
  org,
  repoCount,
  onDeleted,
}: {
  org: string;
  /** Repositories it owns as far as the caller sees (undefined: not read yet). */
  repoCount?: number;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (typed !== org) return;
    setBusy(true);
    setError('');
    try {
      await sourceApi(orgDeletePath(org, typed), { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="org-delete-heading" className="source-danger">
      <h2 id="org-delete-heading">Delete organization</h2>
      <p>
        Deleting removes its members and teams, and its name is retired. It cannot be undone. An
        organization that still owns repositories cannot be deleted: delete them first. Type{' '}
        <strong>{org}</strong> to confirm.
      </p>
      {repoCount !== undefined && repoCount > 0 && (
        <p className="source-meta">
          It owns {repoCount} {repoCount === 1 ? 'repository' : 'repositories'} you can see.
        </p>
      )}
      <form onSubmit={remove} className="source-create" aria-label="Delete organization">
        <label htmlFor="org-delete-confirm" className="sr-only">
          Organization name
        </label>
        <input
          id="org-delete-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="danger" disabled={busy || typed !== org}>
          {busy ? 'Deleting…' : 'Delete this organization'}
        </button>
      </form>
      {error && <Failure error={error} />}
    </section>
  );
}
