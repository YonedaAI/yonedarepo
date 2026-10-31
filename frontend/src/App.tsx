// The one app shell: icon rail, sidebar, top bar and account menu around every page (Home,
// Repositories, Explore, a repository's pages, account settings, device login and, for
// operators, the admin pages). A
// signed-out visitor may open Explore and any public repository; nothing there asks them to
// sign in first. The public site (its own pages, and `/` while signed out) renders in its
// own frame instead.
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AccountSettings } from './features/account-settings/AccountSettings';
import { VerifyEmailPage } from './features/account-settings/VerifyEmailPage';
import { AdminRoot } from './features/admin/AdminRoot';
import { readSeen, type Signups, saveSeen, signupsPath } from './features/admin/adminModel';
import { AgentsRoot } from './features/agents/AgentsRoot';
import { syncAgents } from './features/agents/agentsModel';
import { ExplorePage } from './features/explore/ExplorePage';
import { ReadablePage } from './features/profile/ReadablePage';
import { SearchPage } from './features/search/SearchPage';
import { AppRail } from './features/shell/AppRail';
import { AppSidebar } from './features/shell/AppSidebar';
import { GettingStarted } from './features/shell/GettingStarted';
import { HomePage } from './features/shell/HomePage';
import type { AccountActivity } from './features/shell/homeModel';
import { type Created, NewRepositoryDialog } from './features/shell/NewRepositoryDialog';
import { pickerShortcut, saveRecent } from './features/shell/pickerModel';
import { RepositoriesPage } from './features/shell/RepositoriesPage';
import { type PlatformRepo, repoRows } from './features/shell/repoRows';
import { saveCollapsed, storedCollapsed } from './features/shell/theme';
import { useFavorites } from './features/shell/useFavorites';
import { type Navigate, useRoute } from './features/shell/useRoute';
import { SiteRoot, signedInHint } from './features/site/SiteRoot';
import { siteView } from './features/site/siteRoute';
import { DevicePage } from './features/source-platform/DevicePage';
import { OrgPage } from './features/source-platform/OrgPage';
import type { OrgSummary } from './features/source-platform/orgModel';
import { RepoPage } from './features/source-platform/RepoPage';
import { forgetRepoNames, rememberRepoName } from './features/source-platform/repoNames';
import { managedApi } from './features/source-platform/sourceApi';
import { isAgentsRoute, routeRepo } from './features/source-platform/sourceRoute';
import { useSource } from './features/source-platform/useSource';
import { breadcrumbs } from './features/workspace/breadcrumbs';
import { HandlePrompt } from './features/workspace/HandlePicker';
import {
  type AuthResult,
  PROVIDER_LABEL,
  readAuthResult,
  withoutAuthResult,
} from './features/workspace/oauthModel';
import { SessionEnded } from './features/workspace/SessionEnded';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { type WorkspacePanel, WorkspacePanels } from './features/workspace/WorkspacePanels';
import { useSession } from './hooks/useSession';

let authResult: AuthResult | null | undefined;
/** A provider callback's outcome in the address, read once (per page load) and then dropped
 * from it. */
function takeAuthResult() {
  if (authResult !== undefined || typeof window === 'undefined') return authResult ?? null;
  authResult = readAuthResult(window.location.search);
  if (authResult)
    window.history.replaceState(
      null,
      '',
      withoutAuthResult(window.location.pathname, window.location.search),
    );
  return authResult;
}

export function App() {
  const session = useSession();
  const [route, go] = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  // Following a link closes the phone navigation menu.
  const navigate = useCallback<Navigate>(
    (next, options) => {
      setMenuOpen(false);
      go(next, options);
    },
    [go],
  );
  const [returned] = useState(takeAuthResult);
  // A refused provider sign-in reopens the sign-in panel with the reason; a link is a notice.
  const [signInError, setSignInError] = useState(
    returned && 'error' in returned ? returned.error : '',
  );
  const [panel, setPanel] = useState<WorkspacePanel>(
    signInError && route.view !== 'settings' && route.view !== 'site' ? 'account' : null,
  );
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState(
    returned && 'linked' in returned
      ? `${PROVIDER_LABEL[returned.linked]} is linked: you can sign in with it now.`
      : route.view === 'settings'
        ? signInError
        : '',
  );
  const [tick, setTick] = useState(0);
  // The open repository's name as its status gives it (another account's public repository
  // is in no sidebar row), and whether the viewer may change its settings.
  const [shown, setShown] = useState<{ repo: string; name: string; settings: boolean }>();
  const onLoaded = useCallback(
    (loaded: { repo: string; name: string; settings: boolean }) =>
      setShown({ repo: loaded.repo, name: loaded.name, settings: loaded.settings }),
    [],
  );
  const [missing, setMissing] = useState<string>();
  const platform = useSource<{ repos: PlatformRepo[] }>(session.authenticated ? '/repos' : null);
  const orgs = useSource<{ orgs: OrgSummary[] }>(session.authenticated ? '/orgs' : null);
  const activity = useSource<AccountActivity>(session.authenticated ? '/activity' : null);
  // Operators: the sign-up feed, badged in the sidebar with those since this browser looked.
  const isAdmin = Boolean(session.identity?.is_admin);
  const [signupsSeen, setSignupsSeen] = useState(readSeen);
  const signups = useSource<Signups>(isAdmin ? signupsPath(signupsSeen) : null);
  const onSignupsSeen = useCallback((at: number) => {
    saveSeen(at);
    setSignupsSeen(at);
  }, []);
  // Before anything renders a link, so repository links carry their readable address.
  for (const r of platform.data?.repos ?? []) rememberRepoName(r.id, r.owner_handle, r.name);
  const self = [session.identity?.username, session.identity?.handle];
  const rows = repoRows(platform.data?.repos ?? [], self);
  const favorites = useFavorites(session.authenticated, self);
  const rowsError = platform.error && !/Sign in/.test(platform.error) ? platform.error : '';
  const repo = routeRepo(route);
  const row = repo ? rows.find((r) => r.repo === repo) : undefined;
  const loaded = shown && shown.repo === repo ? shown : undefined;
  // The open repository answered NOT_FOUND or GONE: the shell drops its pages too.
  const gone = Boolean(repo) && repo === missing;
  // The public site (its own pages, and `/` while signed out) renders in its own frame.
  const site = siteView(route, session, signedInHint());
  const opened = session.authenticated ? loaded?.repo : undefined;
  useEffect(() => {
    if (opened) saveRecent(opened);
  }, [opened]);
  // Cmd/Ctrl+K opens the picker wherever the app is on screen; the public docs keep theirs.
  const shortcut = session.authenticated && !site;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (!pickerShortcut(event)) return;
      event.preventDefault();
      setPicking(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);
  useEffect(() => {
    if (!menuOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [menuOpen]);
  useEffect(() => {
    if (!session.sessionEnded) return;
    setPanel(null);
    setCreating(false);
    setPicking(false);
  }, [session.sessionEnded]);
  useEffect(() => {
    if (!session.loading && !session.error) signedInHint(session.authenticated);
  }, [session.loading, session.error, session.authenticated]);

  async function created(result: Created) {
    // Agents set to run on all repositories pick up the new one; best effort, never waited on.
    void syncAgents(result.owner || session.identity?.username, managedApi);
    platform.reload();
    activity.reload();
    navigate({ view: 'files', repo: result.repo, path: '', ref: 'main' });
    setCreating(false);
  }
  const title =
    route.view === 'home'
      ? 'Home'
      : route.view === 'repositories'
        ? 'Repositories'
        : route.view === 'explore'
          ? 'Explore'
          : route.view === 'global-search'
            ? 'Search'
            : route.view === 'settings'
              ? 'Settings'
              : route.view === 'device'
                ? 'Approve a device'
                : route.view === 'verify-email'
                  ? 'Confirm your email'
                  : route.view === 'org'
                    ? route.org
                    : route.view === 'profile'
                      ? route.handle
                      : route.view === 'repo-name'
                        ? route.name
                        : isAgentsRoute(route)
                          ? 'Agents'
                          : route.view === 'admin'
                            ? 'Admin'
                            : gone
                              ? 'Repository not found'
                              : (row?.name ?? loaded?.name ?? repo ?? '');
  const activityError = activity.error && !/Sign in/.test(activity.error) ? activity.error : '';
  const refresh = () => {
    setTick((t) => t + 1);
    platform.reload();
    orgs.reload();
    activity.reload();
    favorites.reload();
    if (isAdmin) signups.reload();
    void session.discover();
  };
  if (site)
    return (
      <SiteRoot
        // A refused provider sign-in that landed on the public home shows the sign-in page.
        site={signInError && site.page === 'home' ? { page: 'signin', mode: 'login' } : site}
        session={session}
        navigate={navigate}
        signInError={signInError}
      />
    );
  return (
    // An open picker shows the sidebar it lives in, whether collapsed or the phone menu.
    <div
      className={`app${collapsed && !picking ? ' sidebar-collapsed' : ''}${menuOpen || picking ? ' menu-open' : ''}`}
    >
      <a className="skip-link" href="#workspace">
        Skip to content
      </a>
      <AppRail
        authenticated={session.authenticated}
        route={route}
        missing={gone}
        collapsed={collapsed}
        onToggle={() => {
          saveCollapsed(!collapsed);
          setCollapsed(!collapsed);
        }}
        navigate={navigate}
        onNew={() => setCreating(true)}
      />
      <AppSidebar
        authenticated={session.authenticated}
        loading={session.loading || platform.loading}
        rows={rows}
        rowsError={rowsError}
        favorites={favorites}
        picking={picking}
        onPicking={setPicking}
        orgs={orgs.data?.orgs ?? []}
        route={route}
        missing={gone}
        repoName={row?.name ?? loaded?.name}
        settings={loaded?.settings}
        navigate={navigate}
        onNew={() => {
          setMenuOpen(false);
          setCreating(true);
        }}
        onRetry={platform.reload}
        admin={isAdmin ? { unread: signups.data?.unread ?? 0 } : undefined}
      />
      <main id="workspace">
        <WorkspaceHeader
          title={title}
          crumbs={breadcrumbs(route, session.identity?.username)}
          loading={session.loading || platform.loading}
          authenticated={session.authenticated}
          identity={session.identity}
          navigate={navigate}
          menuOpen={menuOpen}
          onMenu={() => setMenuOpen(!menuOpen)}
          progress={
            activity.data && (
              <GettingStarted
                steps={activity.data.steps}
                repo={rows[0]?.repo}
                navigate={navigate}
                onNew={() => setCreating(true)}
                onConnect={() => setPanel('cli')}
              />
            )
          }
          onConnect={() => setPanel('cli')}
          onSignIn={() => {
            // The ended-session view already holds the sign-in form; never stack a second one.
            if (session.sessionEnded)
              document.querySelector<HTMLInputElement>('.session-ended input')?.focus();
            else setPanel('account');
          }}
          onSignOut={async () => {
            await session.signOut();
            setPanel(null);
            navigate({ view: 'home' });
          }}
          onError={session.setError}
          onRefresh={refresh}
        />
        {session.sessionEnded ? (
          <SessionEnded onConnected={() => void session.discover()} />
        ) : (
          <>
            {notice && (
              <div role="status" className="workspace-notice">
                <span>{notice}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() => setNotice('')}
                >
                  <X size={17} />
                </button>
              </div>
            )}
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
            {route.view === 'explore' && (
              <ExplorePage authenticated={session.authenticated} navigate={navigate} />
            )}
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
                onAvatar={session.setAvatar}
              />
            )}
            {(route.view === 'profile' || route.view === 'repo-name') && (
              <ReadablePage
                route={route}
                tick={tick}
                navigate={navigate}
                authenticated={session.authenticated}
                onSignIn={() => setPanel('account')}
                onNew={() => setCreating(true)}
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
            {route.view === 'device' && <DevicePage code={route.code} />}
            {route.view === 'verify-email' && (
              <VerifyEmailPage account={route.account} token={route.token} />
            )}
            {route.view === 'org' && (
              <OrgPage
                key={`${route.org}:${tick}`}
                org={route.org}
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
                onNew={() => setCreating(true)}
              />
            )}
          </>
        )}
      </main>
      <WorkspacePanels
        panel={panel}
        authenticated={session.authenticated}
        accountError={signInError}
        onSignedIn={() => void session.discover()}
        onClose={() => {
          setPanel(null);
          setSignInError('');
        }}
      />
      {creating && (
        <NewRepositoryDialog
          account={session.identity?.username}
          orgs={orgs.data?.orgs ?? []}
          initialOwner={
            route.view === 'org' ? route.org : isAgentsRoute(route) ? route.workspace : undefined
          }
          onClose={() => setCreating(false)}
          onCreated={created}
        />
      )}
      <HandlePrompt
        identity={creating ? null : session.identity}
        onSet={(handle) => {
          setNotice(`Your handle is ${handle}. Your profile is at /${handle}.`);
          forgetRepoNames();
          refresh();
        }}
      />
    </div>
  );
}
