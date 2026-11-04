// Account listings and the sign-up feed (new since this browser last looked).
// The repository listing lives in AdminRepositories.
import { useEffect, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import type { Loaded } from '../source-platform/useSource';
import { PagedStatus, SearchBox, usePaged } from './AdminParts';
import {
  type AdminAccount,
  accountsPath,
  nameOf,
  providerLabel,
  type Signups,
  when,
} from './adminModel';

function Status({ account }: { account: AdminAccount }) {
  return (
    <>
      {account.suspended ? (
        <span className="admin-status admin-status-suspended">Suspended</span>
      ) : (
        <span className="admin-status">Active</span>
      )}
      {account.internal && <span className="admin-status">Internal</span>}
    </>
  );
}

const UserLink = ({
  a,
  navigate,
}: {
  a: { account: string; handle: string | null };
  navigate: Navigate;
}) => (
  <a {...linkTo({ view: 'admin', section: 'users', account: a.account }, navigate)}>{nameOf(a)}</a>
);

function UsersTable({ q, navigate }: { q: string; navigate: Navigate }) {
  const paged = usePaged<AdminAccount>((before) => accountsPath(q, before));
  return (
    <>
      {paged.items.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <caption className="sr-only">Accounts, newest first</caption>
            <thead>
              <tr>
                <th>Account</th>
                <th>Signed up with</th>
                <th>Created</th>
                <th>Last seen</th>
                <th className="admin-num">Repositories</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {paged.items.map((a) => (
                <tr key={a.account}>
                  <td>
                    <UserLink a={a} navigate={navigate} />
                    {a.handle && a.handle !== a.account && (
                      <small className="admin-sub">{a.account}</small>
                    )}
                  </td>
                  <td>{providerLabel(a.provider)}</td>
                  <td>{when(a.created_at)}</td>
                  <td>{when(a.last_seen_at)}</td>
                  <td className="admin-num">{a.repos}</td>
                  <td>
                    <Status account={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PagedStatus
        paged={paged}
        what="accounts"
        empty={q ? 'No account matches.' : 'No accounts yet.'}
      />
    </>
  );
}

export function AdminUsers({ navigate }: { navigate: Navigate }) {
  const [q, setQ] = useState('');
  return (
    <>
      <SearchBox label="Search accounts and handles" value={q} onSearch={setQ} />
      <UsersTable key={q} q={q} navigate={navigate} />
    </>
  );
}

export { AdminRepos } from './AdminRepositories';

/** The newest sign-ups; those after this browser's last look are marked new, and opening the
 * feed counts as looking (`onSeen`, with the newest one's time). */
export function AdminSignups({
  signups,
  seen,
  onSeen,
  navigate,
}: {
  signups: Loaded<Signups>;
  seen: number;
  onSeen: (at: number) => void;
  navigate: Navigate;
}) {
  // The marker as it was when the feed opened, so the new rows stay marked while it is open.
  const [since] = useState(seen);
  const newest = signups.data?.items[0]?.created_at ?? 0;
  useEffect(() => {
    if (newest > seen) onSeen(newest);
  }, [newest, seen, onSeen]);
  if (signups.loading && !signups.data) return <Loading what="sign-ups" />;
  if (signups.error || !signups.data)
    return <Failure error={signups.error ?? ''} what="sign-ups" onRetry={signups.reload} />;
  if (!signups.data.items.length) return <p className="source-empty">No sign-ups yet.</p>;
  return (
    <ul className="admin-feed" aria-label="Newest sign-ups">
      {signups.data.items.map((a) => (
        <li key={a.account} className={a.created_at > since ? 'admin-new' : undefined}>
          <UserLink a={a} navigate={navigate} />
          <span className="admin-sub">
            {providerLabel(a.provider)} · {when(a.created_at)}
          </span>
          {a.created_at > since && <span className="admin-status admin-status-new">New</span>}
        </li>
      ))}
    </ul>
  );
}
