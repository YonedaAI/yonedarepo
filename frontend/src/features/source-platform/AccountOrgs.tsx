// Settings → Organizations: the caller's organizations, each a row to its page, and Create
// organization (the page's top right), which asks for the name in a dialog; the creator becomes
// the first owner. An org name is taken from the account namespace.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { Avatar } from '../shell/Avatar';
import { linkTo, type Navigate } from '../shell/useRoute';
import { type OrgSummary, orgNameProblem } from './orgModel';
import { Failure, Loading } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { useChange } from './useChange';
import type { Loaded } from './useSource';

interface Props {
  orgs: Loaded<{ orgs: OrgSummary[] }>;
  navigate: Navigate;
}

/** Mounted while open, so a closed dialog forgets its name and error. */
export function CreateOrgDialog({ orgs, navigate, onClose }: Props & { onClose: () => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useChange(orgs.reload);
  const problem = name ? orgNameProblem(name) : '';
  async function create(event: FormEvent) {
    event.preventDefault();
    const org = name;
    if (await run(() => sourceApi('/orgs', { body: { name: org } })))
      navigate({ view: 'org', org });
  }
  return (
    <Dialog title="Create organization" onClose={onClose} locked={busy} initialFocus="#org-name">
      <form className="new-repository" onSubmit={create}>
        <label htmlFor="org-name">
          Organization name
          <input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            placeholder="acme"
            autoComplete="off"
            disabled={busy}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'org-name-problem' : undefined}
            required
          />
        </label>
        {problem && (
          <span id="org-name-problem" className="form-error">
            {problem}
          </span>
        )}
        {error && <Failure error={error} />}
        <div className="new-repository-actions">
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name || Boolean(problem)}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateOrganization(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Create organization
      </button>
      {open && <CreateOrgDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function AccountOrgs({ orgs, navigate }: Props) {
  if (orgs.loading && !orgs.data) return <Loading what="organizations" />;
  if (orgs.error) return <Failure error={orgs.error} onRetry={orgs.reload} />;
  const list = [...(orgs.data?.orgs ?? [])].sort((a, b) => a.org.localeCompare(b.org));
  if (list.length === 0)
    return (
      <div className="settings-card settings-empty">
        <h2>No organizations yet</h2>
        <p className="source-meta">Create one to share repositories with a team.</p>
      </div>
    );
  return (
    <ul className="org-rows">
      {list.map((o) => (
        <li key={o.org}>
          <a className="org-row" {...linkTo({ view: 'org', org: o.org }, navigate)}>
            <Avatar name={o.org} src={null} size={32} />
            <strong>{o.org}</strong>
            <span className="source-meta">{o.role}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
