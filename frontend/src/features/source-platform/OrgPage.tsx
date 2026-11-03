// An organization's page (`/orgs/:org`): its members, teams and repositories. Every member
// sees it; only owners get the controls (the server refuses everyone else regardless).
import { GitBranch } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { OrgHoldSection, type OrgHolds, OrgRepoHold, orgHeld } from './LegalHold';
import { OrgAudit } from './OrgAudit';
import { DeleteOrganization } from './OrgDelete';
import { OrgMembers } from './OrgMembers';
import { OrgTeams } from './OrgTeams';
import type { Org } from './orgModel';
import { type Deleted, RecentlyDeleted } from './RecentlyDeleted';
import { Failure, Loading } from './SourceStatus';
import { when } from './sourceApi';
import { type Loaded, useSource } from './useSource';

type OrgRepo = { id: string; name: string; created_at: number; owner: string };

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
  if (list.length === 0)
    return (
      <p className="source-empty">
        {manages ? 'No repositories yet.' : 'No repositories available.'}
      </p>
    );
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
  const reposHeading = useRef<HTMLHeadingElement>(null);
  const deletedCount = deleted.data?.repos.length ?? 0;
  const previousDeletedCount = useRef(deletedCount);
  useEffect(() => {
    // The last recovery button left the page; preserve a keyboard user's place.
    if (
      previousDeletedCount.current > 0 &&
      deletedCount === 0 &&
      document.activeElement === document.body
    )
      reposHeading.current?.focus();
    previousDeletedCount.current = deletedCount;
  }, [deletedCount]);

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

  return (
    <div className="org-page source-tokens">
      <header className="org-header">
        <h1>{data.org}</h1>
        <p className="source-meta">
          Created {when(data.created_at)}{' '}
          <span className="chip">{manages ? 'Owner' : 'Member'}</span>
        </p>
      </header>
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
          <OrgMembers
            org={org}
            members={data.members}
            manages={manages}
            onChanged={loaded.reload}
          />
          <OrgTeams org={org} data={data} manages={manages} onChanged={loaded.reload} />
          <section aria-labelledby="org-repos-heading" className="org-section">
            <h2 id="org-repos-heading" ref={reposHeading} tabIndex={-1}>
              Repositories
            </h2>
            <OrgRepos org={org} repos={repos} holds={holds} manages={manages} navigate={navigate} />
          </section>
          {manages && deleted.error && <Failure error={deleted.error} onRetry={deleted.reload} />}
          {manages && deletedCount > 0 ? (
            <details className="org-section org-deleted">
              <summary>
                Recently deleted <span className="chip">{deleted.data?.repos.length ?? 0}</span>
              </summary>
              <RecentlyDeleted loaded={deleted} onRestored={repos.reload} />
            </details>
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
