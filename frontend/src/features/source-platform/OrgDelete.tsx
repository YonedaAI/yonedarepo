// An owner retires an organization (`DELETE /orgs/:org?confirm=<org>`), typing its name to
// confirm. The server refuses (409) while the org still owns repositories; that answer is
// shown here with the next step.
import { type FormEvent, useState } from 'react';
import { HELD_NOTE } from './LegalHold';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';

export const orgDeletePath = (org: string, typed: string) =>
  `/orgs/${encodeURIComponent(org)}?confirm=${encodeURIComponent(typed)}`;

export function DeleteOrganization({
  org,
  repoCount,
  inWindow = 0,
  held = false,
  onDeleted,
}: {
  org: string;
  /** Under a legal hold: the server would refuse. */
  held?: boolean;
  /** Repositories it owns as far as the caller sees (undefined: not read yet). */
  repoCount?: number;
  /** Its repositories that can still be restored: nobody can, once it is gone. */
  inWindow?: number;
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
        This can&apos;t be undone. Type <strong>{org}</strong> to confirm.
      </p>
      {repoCount !== undefined && repoCount > 0 && (
        <p className="source-meta">
          Delete its {repoCount} {repoCount === 1 ? 'repository' : 'repositories'} first.
        </p>
      )}
      {inWindow > 0 && (
        <p className="source-meta">
          {inWindow} deleted {inWindow === 1 ? 'repository' : 'repositories'} can still be restored.
          After this, only their owners can restore them.
        </p>
      )}
      {held && <p className="source-meta">{HELD_NOTE}</p>}
      <form onSubmit={remove} className="source-create" aria-label="Delete organization">
        <label htmlFor="org-delete-confirm" className="org-confirm-label">
          Organization name
        </label>
        <input
          id="org-delete-confirm"
          disabled={held}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="danger" disabled={busy || held || typed !== org}>
          {busy ? 'Deleting…' : 'Delete this organization'}
        </button>
      </form>
      {error && <Failure error={error} />}
    </section>
  );
}
