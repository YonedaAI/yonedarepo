// Account settings → Organizations: the caller's organizations and a form to create one
// (the creator becomes its first owner). An org name is taken from the account namespace.
import { type FormEvent, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { type OrgSummary, orgNameProblem } from './orgModel';
import { Failure, Loading } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { useChange } from './useChange';
import type { Loaded } from './useSource';

export function AccountOrgs({
  orgs,
  navigate,
}: {
  orgs: Loaded<{ orgs: OrgSummary[] }>;
  navigate: Navigate;
}) {
  const [name, setName] = useState('');
  const { busy, error, run } = useChange(orgs.reload);
  const problem = name ? orgNameProblem(name) : '';
  async function create(event: FormEvent) {
    event.preventDefault();
    const org = name;
    if (await run(() => sourceApi('/orgs', { body: { name: org } })))
      navigate({ view: 'org', org });
  }
  const list = [...(orgs.data?.orgs ?? [])].sort((a, b) => a.org.localeCompare(b.org));
  return (
    <div className="settings-card">
      <p className="source-meta">
        An organization owns repositories together. Owners manage its members and teams; teams get
        roles on repositories.
      </p>
      {orgs.loading && !orgs.data ? (
        <Loading what="organizations" />
      ) : orgs.error ? (
        <Failure error={orgs.error} onRetry={orgs.reload} />
      ) : list.length === 0 ? (
        <p className="source-empty">You are in no organization.</p>
      ) : (
        <ul className="org-list">
          {list.map((o) => (
            <li key={o.org}>
              <a {...linkTo({ view: 'org', org: o.org }, navigate)}>{o.org}</a>{' '}
              <span className="source-meta">{o.role}</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="source-token-form">
        <label htmlFor="org-name" className="source-field">
          New organization
          <input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            placeholder="acme"
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'org-name-problem' : undefined}
            required
          />
        </label>
        <button type="submit" disabled={busy || !name || Boolean(problem)}>
          {busy ? 'Creating…' : 'Create organization'}
        </button>
        {problem && (
          <span id="org-name-problem" className="form-error">
            {problem}
          </span>
        )}
      </form>
      {error && <Failure error={error} />}
    </div>
  );
}
