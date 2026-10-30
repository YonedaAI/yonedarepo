// The operators' admin pages (`/admin/*`): Overview, Users (and one user), Sign-ups,
// Repositories, Audit log and Traffic, under one tab bar. The sidebar shows the entry only to
// operators; the API refuses everyone else whatever this page shows.
import { linkTo, type Navigate } from '../shell/useRoute';
import type { Loaded } from '../source-platform/useSource';
import { AdminAudit, AdminRepos, AdminSignups, AdminUsers } from './AdminLists';
import { AdminOverview } from './AdminOverview';
import { AdminTraffic } from './AdminTraffic';
import { AdminUser } from './AdminUser';
import {
  ADMIN_SECTIONS,
  type AdminSection,
  SECTION_LABEL,
  type Signups,
  unreadLabel,
} from './adminModel';

export function AdminRoot({
  section,
  account,
  self,
  signups,
  seen,
  onSeen,
  navigate,
}: {
  section: AdminSection;
  account?: string;
  self?: string;
  /** The sign-up feed (read by the shell, which badges it in the sidebar). */
  signups: Loaded<Signups>;
  /** When this browser last looked at the sign-ups, and the callback that moves it. */
  seen: number;
  onSeen: (at: number) => void;
  navigate: Navigate;
}) {
  const unread = signups.data?.unread ?? 0;
  return (
    <section className="admin" aria-labelledby="admin-heading">
      <div className="page-heading">
        <h1 id="admin-heading">Admin</h1>
      </div>
      <nav className="admin-tabs" aria-label="Admin sections">
        {ADMIN_SECTIONS.map((id) => (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link.
          <a
            key={id}
            {...(id === section ? { 'aria-current': 'page' as const, className: 'active' } : {})}
            aria-label={
              id === 'signups' && unread > 0 ? `${SECTION_LABEL[id]}, ${unread} new` : undefined
            }
            {...linkTo({ view: 'admin', section: id }, navigate)}
          >
            {SECTION_LABEL[id]}
            {id === 'signups' && unread > 0 && (
              <small className="side-badge" aria-hidden="true">
                {unreadLabel(unread)}
              </small>
            )}
          </a>
        ))}
      </nav>
      {section === 'overview' && <AdminOverview />}
      {section === 'users' &&
        (account ? (
          <AdminUser key={account} account={account} self={self} navigate={navigate} />
        ) : (
          <AdminUsers navigate={navigate} />
        ))}
      {section === 'signups' && (
        <AdminSignups signups={signups} seen={seen} onSeen={onSeen} navigate={navigate} />
      )}
      {section === 'repos' && <AdminRepos navigate={navigate} />}
      {section === 'audit' && <AdminAudit />}
      {section === 'traffic' && <AdminTraffic />}
    </section>
  );
}
