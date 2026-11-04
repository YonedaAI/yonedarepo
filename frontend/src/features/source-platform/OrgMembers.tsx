// Organization membership controls; the server authorizes every role change.
import { type FormEvent, useState } from 'react';
import { type OrgMemberCandidate, OrgMemberPicker } from './OrgMemberPicker';
import { ORG_ROLES, type OrgMember, type OrgRole } from './orgModel';
import { Failure } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { useChange } from './useChange';

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
  const owners = members.filter((member) => member.role === 'owner').length;
  return (
    <div className="source-table-wrap org-member-table">
      <table className="source-table">
        <colgroup>
          <col />
          <col className="org-member-role-column" />
          <col className="org-member-actions-column" />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th>Member</th>
            <th>Role</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const lastOwner = m.role === 'owner' && owners === 1;
            return (
              <tr key={m.account}>
                <td>
                  <span className="org-member-name">{m.account}</span>
                  <span
                    className="source-meta org-member-added"
                    title={`Added ${when(m.added_at)} by ${m.added_by.replace(/^user:/, '')}`}
                  >
                    Added{' '}
                    {new Date(m.added_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </td>
                {lastOwner || !manages ? (
                  <td colSpan={2} className="org-member-static-role">
                    <span className={lastOwner ? 'chip' : 'source-meta'}>
                      {m.role === 'owner' ? 'Owner' : 'Member'}
                    </span>
                  </td>
                ) : (
                  <>
                    <td>
                      <select
                        aria-label={`Role of ${m.account}`}
                        value={m.role}
                        onChange={(e) => onRole(m.account, e.target.value as OrgRole)}
                      >
                        {ORG_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r === 'owner' ? 'Owner' : 'Member'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button type="button" className="quiet" onClick={() => onRemove(m.account)}>
                        Remove
                      </button>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OrgMembers({
  org,
  members,
  manages,
  onChanged,
}: {
  org: string;
  members: OrgMember[];
  manages: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useChange(onChanged);
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState<OrgMemberCandidate | null>(null);
  const [role, setRole] = useState<OrgRole>('member');
  const base = `/orgs/${org}`;
  const put = (who: string, to: OrgRole) =>
    run(() => sourceApi(`${base}/members`, { body: { account: who, role: to } }));
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || !selected || selected.member) return;
    if (await put(selected.identifier, role)) {
      setAccount('');
      setSelected(null);
    }
  }
  function remove(who: string) {
    if (!window.confirm(`Remove ${who} from ${org}? They leave every team, at once.`)) return;
    void run(() => sourceApi(`${base}/members/${encodeURIComponent(who)}`, { method: 'DELETE' }));
  }

  return (
    <section aria-labelledby="org-members-heading" className="org-section">
      <h2 id="org-members-heading">Members</h2>
      <MemberRows members={members} manages={manages} onRole={put} onRemove={remove} />
      {manages && (
        <form onSubmit={add} className="source-token-form org-member-form">
          <OrgMemberPicker
            org={org}
            value={account}
            selected={selected}
            disabled={busy}
            onChange={(value) => {
              setAccount(value);
              setSelected(null);
            }}
            onSelect={(candidate) => {
              setAccount(candidate.handle ? `@${candidate.handle}` : candidate.identifier);
              setSelected(candidate);
            }}
          />
          <label htmlFor="org-member-role" className="source-field">
            Role
            <select
              id="org-member-role"
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
            >
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r === 'owner' ? 'Owner' : 'Member'}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy || !selected || selected.member}>
            {busy ? 'Saving…' : 'Add member'}
          </button>
          {account.trim() && (
            <p className="source-meta org-form-hint">
              {role === 'owner'
                ? 'Owners manage all repositories, members and teams.'
                : 'Members get repository access through teams.'}
            </p>
          )}
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
