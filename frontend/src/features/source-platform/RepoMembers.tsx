// Repository members: other accounts, or an organization's teams (`team:<org>/<team>`), that
// use this repository with a role. The owner and
// admins manage them; only the owner grants, changes or removes admin. The server decides
// every change; the page only hides controls the viewer cannot use.
import { type FormEvent, useState } from 'react';
import { memberTarget, teamOf } from './orgModel';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

export const MEMBER_ROLES = ['read', 'write', 'land', 'admin'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type Member = { account: string; role: MemberRole; added_by: string; added_at: number };
/** The caller as `GET /repos/:id` reports it: `role` is null for the owner. */
export type Viewer = { owner: boolean; role: MemberRole | null };

export const ROLE_HELP: Record<MemberRole, string> = {
  read: 'read and clone',
  write: 'also commit, push branches and post checks',
  land: 'also review and land on main',
  admin: 'also manage tokens, policy, hooks and members',
};

/** The roles `viewer` may give or take away (admins never touch admin). */
export const assignable = (viewer: Viewer): MemberRole[] =>
  viewer.role === null ? [...MEMBER_ROLES] : MEMBER_ROLES.filter((r) => r !== 'admin');

export function MemberTable({
  members,
  viewer,
  onRole,
  onRemove,
}: {
  members: Loaded<{ members: Member[] }>;
  viewer: Viewer;
  onRole: (account: string, role: MemberRole) => void;
  onRemove: (account: string) => void;
}) {
  if (members.loading && !members.data) return <Loading what="members" />;
  if (members.error) return <Failure error={members.error} onRetry={members.reload} />;
  const rows = members.data?.members ?? [];
  if (rows.length === 0)
    return <p className="source-empty">Only the owner uses this repository.</p>;
  const roles = assignable(viewer);
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
          {rows.map((m) => {
            const editable = roles.includes(m.role);
            return (
              <tr key={m.account}>
                <td>
                  <MemberName account={m.account} />
                </td>
                <td>
                  {editable ? (
                    <select
                      aria-label={`Role of ${m.account}`}
                      value={m.role}
                      onChange={(e) => onRole(m.account, e.target.value as MemberRole)}
                    >
                      {roles.map((r) => (
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
                  {editable && (
                    <button type="button" className="quiet" onClick={() => onRemove(m.account)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** An account, or a team shown as `org/team` with a label. */
export function MemberName({ account }: { account: string }) {
  const team = teamOf(account);
  if (!team) return <>{account}</>;
  return (
    <>
      <span className="member-kind">team</span> {team.org}/{team.team}
    </>
  );
}

export function RepoMembers({ repo, viewer }: { repo: string; viewer?: Viewer }) {
  const manages = viewer?.owner === true;
  const members = useSource<{ members: Member[] }>(manages ? `/repos/${repo}/members` : null);
  const [kind, setKind] = useState<'account' | 'team'>('account');
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<MemberRole>('write');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(run: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await run();
      members.reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const put = (who: string, to: MemberRole) =>
    change(() => sourceApi(`/repos/${repo}/members`, { body: { account: who, role: to } }));
  const target = memberTarget(kind, account);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (target && (await put(target, role))) setAccount('');
  }
  function remove(who: string) {
    const team = teamOf(who);
    const label = team ? `team ${team.org}/${team.team}` : who;
    if (!window.confirm(`Remove ${label}? Their access ends immediately.`)) return;
    void change(() =>
      sourceApi(`/repos/${repo}/members/${encodeURIComponent(who)}`, { method: 'DELETE' }),
    );
  }

  if (!viewer) return <Loading what="your access" />;
  if (!manages)
    return (
      <section aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        <p className="source-meta">
          You are a member with the {viewer.role} role ({viewer.role && ROLE_HELP[viewer.role]}).
          The owner and admins manage members.
        </p>
      </section>
    );
  return (
    <section aria-labelledby="members-heading">
      <h2 id="members-heading">Members</h2>
      <p className="source-meta">
        Other accounts and organization teams that use this repository. A member&apos;s personal
        token holds only what both its scopes and the role allow; a team member holds the
        team&apos;s role.
      </p>
      <MemberTable members={members} viewer={viewer} onRole={put} onRemove={remove} />
      <form onSubmit={add} className="source-token-form">
        <label htmlFor="member-kind" className="source-field">
          Grant to
          <select
            id="member-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'account' | 'team')}
          >
            <option value="account">an account</option>
            <option value="team">an organization team</option>
          </select>
        </label>
        <label htmlFor="member-account" className="source-field">
          {kind === 'team' ? 'Team' : 'Account'}
          <input
            id="member-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder={kind === 'team' ? 'org/team' : 'username'}
            autoComplete="off"
            aria-invalid={account.trim() && !target ? true : undefined}
            required
          />
        </label>
        <label htmlFor="member-role" className="source-field">
          Role
          <select
            id="member-role"
            value={role}
            onChange={(e) => setRole(e.target.value as MemberRole)}
          >
            {assignable(viewer).map((r) => (
              <option key={r} value={r}>
                {r}: {ROLE_HELP[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || !target}>
          {busy ? 'Saving…' : kind === 'team' ? 'Add team' : 'Add member'}
        </button>
      </form>
      {error && <Failure error={error} />}
    </section>
  );
}
