// An organization's page (`/orgs/:org`): its members, teams and repositories. Every member
// sees it; only owners get the controls (the server refuses everyone else regardless).
import { GitBranch } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { OrgTeams } from './OrgTeams';
import { ORG_ROLE_HELP, ORG_ROLES, type Org, type OrgMember, type OrgRole } from './orgModel';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { useChange } from './useChange';
import { useSource } from './useSource';

type OrgRepo = { id: string; name: string; created_at: number; owner: string };

function MemberRows({
  members,
  manages,
  onRole,
  onRemove,
}: {
  members: OrgMember[];
  manages: boolean;
  onRole: (account: string, role: OrgRole) => void;
  onRemove: (account: string) => void;
}) {
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Role</th>
            <th>Added</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.account}>
              <td>{m.account}</td>
              <td>
                {manages ? (
                  <select
                    aria-label={`Role of ${m.account}`}
                    value={m.role}
                    onChange={(e) => onRole(m.account, e.target.value as OrgRole)}
                  >
                    {ORG_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td>
                {when(m.added_at)} by {m.added_by.replace(/^user:/, '')}
              </td>
              <td>
                {manages && (
                  <button type="button" className="quiet" onClick={() => onRemove(m.account)}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrgRepos({ org, navigate }: { org: string; navigate: Navigate }) {
  const repos = useSource<{ repos: OrgRepo[] }>(`/orgs/${org}/repos`);
  if (repos.loading && !repos.data) return <Loading what="repositories" />;
  if (repos.error) return <Failure error={repos.error} onRetry={repos.reload} />;
  const list = [...(repos.data?.repos ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0)
    return (
      <p className="source-empty">
        No repositories you can use yet. Owners create them with New repository and this
        organization as the owner.
      </p>
    );
  return (
    <ul className="org-repos">
      {list.map((r) => (
        <li key={r.id}>
          <a {...linkTo({ view: 'files', repo: r.id, path: '', ref: 'main' }, navigate)}>
            <GitBranch size={16} aria-hidden="true" /> {r.name}
          </a>{' '}
          <span className="source-meta">created {when(r.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

export function OrgPage({ org, navigate }: { org: string; navigate: Navigate }) {
  const loaded = useSource<Org>(`/orgs/${org}`);
  const { busy, error, run } = useChange(loaded.reload);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<OrgRole>('member');

  if (loaded.loading && !loaded.data) return <Loading what="the organization" />;
  if (loaded.error || !loaded.data)
    return <Failure error={loaded.error ?? 'Organization not found'} onRetry={loaded.reload} />;
  const data = loaded.data;
  const manages = data.role === 'owner';
  const base = `/orgs/${org}`;
  const put = (who: string, to: OrgRole) =>
    run(() => sourceApi(`${base}/members`, { body: { account: who, role: to } }));
  async function add(event: FormEvent) {
    event.preventDefault();
    if (await put(account.trim(), role)) setAccount('');
  }
  function remove(who: string) {
    if (!window.confirm(`Remove ${who} from ${org}? They leave every team, at once.`)) return;
    void run(() => sourceApi(`${base}/members/${encodeURIComponent(who)}`, { method: 'DELETE' }));
  }

  return (
    <div className="org-page source-tokens">
      <h1>{data.org}</h1>
      <p className="source-meta">
        Organization created {when(data.created_at)} by {data.created_by.replace(/^user:/, '')}. You
        are {data.role === 'owner' ? 'an owner' : 'a member'} ({ORG_ROLE_HELP[data.role]}).
      </p>
      <section aria-labelledby="org-members-heading">
        <h2 id="org-members-heading">Members</h2>
        <MemberRows members={data.members} manages={manages} onRole={put} onRemove={remove} />
        {manages && (
          <form onSubmit={add} className="source-token-form">
            <label htmlFor="org-member-account" className="source-field">
              Account
              <input
                id="org-member-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="username"
                autoComplete="off"
                required
              />
            </label>
            <label htmlFor="org-member-role" className="source-field">
              Role
              <select
                id="org-member-role"
                value={role}
                onChange={(e) => setRole(e.target.value as OrgRole)}
              >
                {ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}: {ORG_ROLE_HELP[r]}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || !account.trim()}>
              {busy ? 'Saving…' : 'Add member'}
            </button>
          </form>
        )}
        {error && <Failure error={error} />}
      </section>
      <OrgTeams org={org} data={data} manages={manages} onChanged={loaded.reload} />
      <section aria-labelledby="org-repos-heading">
        <h2 id="org-repos-heading">Repositories</h2>
        <OrgRepos org={org} navigate={navigate} />
      </section>
    </div>
  );
}
