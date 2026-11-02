// An organization's page (`/orgs/:org`): its members, teams and repositories. Every member
// sees it; only owners get the controls (the server refuses everyone else regardless).
import { GitBranch } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { OrgHoldSection, type OrgHolds, OrgRepoHold, orgHeld } from './LegalHold';
import { OrgAudit } from './OrgAudit';
import { DeleteOrganization } from './OrgDelete';
import { OrgTeams } from './OrgTeams';
import { ORG_ROLE_HELP, ORG_ROLES, type Org, type OrgMember, type OrgRole } from './orgModel';
import { type Deleted, RecentlyDeleted } from './RecentlyDeleted';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { useChange } from './useChange';
import { type Loaded, useSource } from './useSource';

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

function OrgRepos({
  org,
  repos,
  holds,
  manages,
  navigate,
}: {
  org: string;
  repos: Loaded<{ repos: OrgRepo[] }>;
  /** Legal holds, where the platform has them. */
  holds: Loaded<OrgHolds>;
  manages: boolean;
  navigate: Navigate;
}) {
  if (repos.loading && !repos.data) return <Loading what="repositories" />;
  if (repos.error) return <Failure error={repos.error} onRetry={repos.reload} />;
  const list = [...(repos.data?.repos ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return <p className="source-empty">No repositories you can use yet.</p>;
  return (
    <ul className="org-repos">
      {list.map((r) => (
        <li key={r.id}>
          <a {...linkTo({ view: 'overview', repo: r.id }, navigate)}>
            <GitBranch size={16} aria-hidden="true" /> {r.name}
          </a>{' '}
          <span className="source-meta">created {when(r.created_at)}</span>
          {holds.data && (
            <OrgRepoHold
              org={org}
              repo={r.id}
              name={r.name}
              hold={holds.data.repos[r.id]}
              manages={manages}
              onChanged={holds.reload}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** The tabs an owner gets while the platform keeps audit logs. */
function OrgTabs({ org, tab, navigate }: { org: string; tab?: 'audit'; navigate: Navigate }) {
  const pick = (target?: 'audit') =>
    target === tab ? { 'aria-current': 'page' as const, className: 'active' } : {};
  return (
    <nav className="admin-tabs" aria-label="Organization sections">
      <a {...pick()} {...linkTo({ view: 'org', org }, navigate)}>
        Overview
      </a>
      <a {...pick('audit')} {...linkTo({ view: 'org', org, tab: 'audit' }, navigate)}>
        Audit log
      </a>
    </nav>
  );
}

export function OrgPage({
  org,
  tab,
  navigate,
  onDeleted,
}: {
  org: string;
  tab?: 'audit';
  navigate: Navigate;
  /** After an owner deleted it: the shell re-reads the caller's orgs and leaves the page. */
  onDeleted?: () => void;
}) {
  const loaded = useSource<Org>(`/orgs/${org}`);
  const repos = useSource<{ repos: OrgRepo[] }>(`/orgs/${org}/repos`);
  const holds = useSource<OrgHolds>(`/orgs/${org}/hold`);
  // Its owners': the only people who can restore them.
  const owner = loaded.data?.role === 'owner';
  const deleted = useSource<Deleted>(owner ? `/orgs/${org}/repos/deleted` : null);
  const { busy, error, run } = useChange(loaded.reload);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<OrgRole>('member');

  if (!loaded.data || loaded.error)
    return (
      <div className="org-page">
        {loaded.loading && !loaded.data ? (
          <Loading what="the organization" />
        ) : (
          <Failure error={loaded.error ?? 'Organization not found'} onRetry={loaded.reload} />
        )}
      </div>
    );
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
        Created {when(data.created_at)} by {data.created_by.replace(/^user:/, '')}. You are{' '}
        {data.role === 'owner' ? 'an owner' : 'a member'}.
      </p>
      {data.audit_log && manages && <OrgTabs org={org} tab={tab} navigate={navigate} />}
      {tab === 'audit' && data.audit_log && manages && <OrgAudit org={org} />}
      {tab === 'audit' && !(data.audit_log && manages) && (
        <p className="source-empty">
          {data.audit_log
            ? 'Only owners of this organization can see its audit log.'
            : 'The audit log isn’t turned on here.'}
        </p>
      )}
      {!tab && (
        <>
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
            <OrgRepos org={org} repos={repos} holds={holds} manages={manages} navigate={navigate} />
          </section>
          {manages && (deleted.data?.window_days || deleted.data?.repos.length) ? (
            <section aria-labelledby="org-deleted-heading">
              <h2 id="org-deleted-heading">Recently deleted</h2>
              <RecentlyDeleted loaded={deleted} onRestored={repos.reload} />
            </section>
          ) : null}
          {holds.data && (
            <OrgHoldSection
              org={org}
              holds={holds.data}
              manages={manages}
              onChanged={holds.reload}
            />
          )}
          {manages && onDeleted && (
            <DeleteOrganization
              org={org}
              repoCount={repos.data?.repos.length}
              inWindow={deleted.data?.repos.length}
              held={orgHeld(holds.data)}
              onDeleted={onDeleted}
            />
          )}
        </>
      )}
    </div>
  );
}
