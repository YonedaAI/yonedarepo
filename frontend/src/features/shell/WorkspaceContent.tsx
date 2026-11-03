// Workspace route content and the single session-ended admission view.
import { AccountSettings } from '../account-settings/AccountSettings';
import { EmailLinkPage } from '../account-settings/EmailLinkPage';
import { isEmailLink } from '../account-settings/emailLinkRoute';
import { AdminRoot } from '../admin/AdminRoot';
import { AgentsRoot } from '../agents/AgentsRoot';
import { ExplorePage } from '../explore/ExplorePage';
import { ReadablePage } from '../profile/ReadablePage';
import { SearchPage } from '../search/SearchPage';
import { OrgPage } from '../source-platform/OrgPage';
import { RepoPage } from '../source-platform/RepoPage';
import { isAgentsRoute } from '../source-platform/sourceRoute';
import { SessionEnded } from '../workspace/SessionEnded';
import { HomePage } from './HomePage';
import { Notice } from './Notice';
import { RepositoriesPage } from './RepositoriesPage';
import type { AppShell } from './useAppShell';

export function WorkspaceContent({ shell }: { shell: AppShell }) {
  const {
    session,
    route,
    navigate,
    setPanel,
    setCreating,
    notice,
    setNotice,
    tick,
    onLoaded,
    setMissing,
    platform,
    orgs,
    activity,
    isAdmin,
    signups,
    signupsSeen,
    onSignupsSeen,
    rows,
    favorites,
    rowsError,
    row,
    activityError,
    handleChosen,
  } = shell;
  return (
    <>
      {/* A reset ends this browser's session too; its recovery code must stay on screen. */}
      {session.sessionEnded && route.view !== 'reset-password' ? (
        <SessionEnded onConnected={() => void session.discover()} />
      ) : (
        <>
          <Notice notice={notice} onDismiss={() => setNotice('')} />
          {route.view === 'home' && (
            <HomePage
              session={session}
              activity={activity.data}
              activityLoading={activity.loading}
              activityError={activityError}
              onRetry={() => {
                activity.reload();
                void session.discover();
              }}
              navigate={navigate}
              onNew={() => setCreating(true)}
            />
          )}
          {route.view === 'repositories' && (
            <RepositoriesPage
              session={session}
              rows={rows}
              rowsLoading={platform.loading}
              rowsError={rowsError}
              onRetry={() => {
                platform.reload();
                void session.discover();
              }}
              navigate={navigate}
              onNew={() => setCreating(true)}
            />
          )}
          {route.view === 'explore' && <ExplorePage navigate={navigate} />}
          {route.view === 'global-search' && (
            <SearchPage
              key={tick}
              route={route}
              authenticated={session.authenticated}
              repos={platform.data?.repos ?? []}
              sessions={activity.data?.sessions ?? []}
              // First reads only: a later reload keeps the search that is on the page.
              loading={
                session.loading ||
                (session.authenticated &&
                  ((!platform.data && !platform.error) || (!activity.data && !activity.error)))
              }
              reposError={rowsError}
              onRetry={platform.reload}
              navigate={navigate}
              onSignIn={() => setPanel('account')}
              onNew={() => setCreating(true)}
            />
          )}
          {route.view === 'settings' && (
            <AccountSettings
              section={route.section}
              identity={session.identity}
              loading={session.loading}
              repos={rows.map((r) => ({ id: r.repo, name: r.name }))}
              orgs={orgs}
              navigate={navigate}
              onIdentity={session.patchIdentity}
              onHandle={handleChosen}
              onRestored={() => {
                platform.reload();
                activity.reload();
                favorites.reload();
              }}
            />
          )}
          {(route.view === 'profile' || route.view === 'repo-name') && (
            <ReadablePage
              route={route}
              tick={tick}
              navigate={navigate}
              authenticated={session.authenticated}
              onSignIn={() => setPanel('account')}
            />
          )}
          {route.view === 'admin' &&
            (isAdmin ? (
              <AdminRoot
                section={route.section}
                account={route.account}
                self={session.identity?.username}
                signups={signups}
                seen={signupsSeen}
                onSeen={onSignupsSeen}
                navigate={navigate}
              />
            ) : (
              !session.loading && (
                <p className="source-empty">The admin pages are for operators only.</p>
              )
            ))}
          {isEmailLink(route) && <EmailLinkPage route={route} />}
          {route.view === 'org' && (
            <OrgPage
              key={`${route.org}:${tick}`}
              org={route.org}
              tab={route.tab}
              navigate={navigate}
              onDeleted={() => {
                orgs.reload();
                navigate({ view: 'settings', section: 'organizations' });
                setNotice('Organization deleted.');
              }}
            />
          )}
          {isAgentsRoute(route) && (
            <AgentsRoot
              key={`${tick}:${session.identity?.username ?? ''}`}
              route={route}
              account={session.identity?.username}
              orgs={orgs.data?.orgs ?? []}
              navigate={navigate}
              onNewRepository={() => setCreating(true)}
            />
          )}
          {'repo' in route && (
            <RepoPage
              // A sign-in or sign-out changes who is asking: read the status again.
              key={`${route.repo}:${tick}:${session.identity?.username ?? ''}`}
              route={route}
              name={row?.name}
              authenticated={session.authenticated}
              username={session.identity?.username}
              navigate={navigate}
              onSignIn={() => setPanel('account')}
              onLoaded={onLoaded}
              onDeleted={() => {
                platform.reload();
                activity.reload();
                favorites.reload();
                navigate({ view: 'home' });
                setNotice('Repository deleted.');
              }}
              onMissing={() => {
                // A stale sidebar entry (deleted elsewhere) drops out with the refreshed list.
                setMissing(route.repo);
                platform.reload();
                favorites.reload();
              }}
            />
          )}
        </>
      )}
    </>
  );
}
