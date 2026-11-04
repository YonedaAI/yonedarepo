// Shared shell state, admission and background reads; page content never waits for decoration.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../hooks/useSession';
import { emailLinkTitle, isEmailLink } from '../account-settings/emailLinkRoute';
import { useSignups } from '../admin/useSignups';
import { syncAgents } from '../agents/agentsModel';
import { personalWorkspaceHint, signedInHint } from '../site/signedInHint';
import { siteView } from '../site/siteRoute';
import type { OrgSummary } from '../source-platform/orgModel';
import {
  advanceOverviewViewer,
  type OverviewHandoff,
  type OverviewViewer,
  overviewForNavigation,
} from '../source-platform/overviewBootstrap';
import type { ShownRepo } from '../source-platform/RepoPage';
import { forgetRepoNames, rememberRepoName } from '../source-platform/repoNames';
import { managedApi } from '../source-platform/sourceApi';
import { isAgentsRoute, routeRepo } from '../source-platform/sourceRoute';
import { useSource } from '../source-platform/useSource';
import { PROVIDER_LABEL } from '../workspace/oauthModel';
import { takeAuthResult } from '../workspace/returnedAuth';
import type { WorkspacePanel } from '../workspace/WorkspacePanels';
import { backFromGitHub } from './GitHubImportDialog';
import type { AccountActivity } from './homeModel';
import type { Created } from './NewRepositoryDialog';
import { useNotice } from './Notice';
import { pickerShortcut, saveRecent } from './pickerModel';
import { type PlatformRepo, repoRows } from './repoRows';
import { storedCollapsed } from './theme';
import { useFavorites } from './useFavorites';
import { type Navigate, useRoute } from './useRoute';

export function useAppShell() {
  const session = useSession();
  const [route, go] = useRoute();
  const [tick, setTick] = useState(0);
  const [overviewHandoff, setOverviewHandoff] = useState<OverviewHandoff>();
  const viewerState = useRef<OverviewViewer>({ generation: 0 });
  viewerState.current = advanceOverviewViewer(
    viewerState.current,
    `${session.authenticated}:${session.identity?.username ?? ''}:${session.sessionEnded}`,
    !session.loading,
  );
  const viewer = String(viewerState.current.generation);
  const overviewPrincipal = session.loading
    ? undefined
    : session.identity?.username
      ? `user:${session.identity.username}`
      : 'anonymous';
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  // Following a link closes the phone navigation menu.
  const navigate = useCallback<Navigate>(
    (next, options) => {
      setMenuOpen(false);
      setOverviewHandoff(
        options?.overview ? { route: next, viewer, tick, overview: options.overview } : undefined,
      );
      go(next, options);
    },
    [go, viewer, tick],
  );
  useEffect(() => {
    setOverviewHandoff((value) => (value?.viewer === viewer ? value : undefined));
  }, [viewer]);
  const [returned] = useState(takeAuthResult);
  // A refused provider sign-in reopens the sign-in panel with the reason; a link is a notice.
  const [signInError, setSignInError] = useState(
    returned && 'error' in returned ? returned.error : '',
  );
  const [panel, setPanel] = useState<WorkspacePanel>(
    signInError && route.view !== 'settings' && route.view !== 'site' ? 'account' : null,
  );
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState<boolean | 'public'>(backFromGitHub);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useNotice(
    returned && 'linked' in returned
      ? `${PROVIDER_LABEL[returned.linked]} is linked: you can sign in with it now.`
      : route.view === 'settings'
        ? signInError
        : '',
    signInError,
  );
  // The open repository as its status gives it: another account's is in no sidebar row.
  const [shown, setShown] = useState<ShownRepo>();
  const onLoaded = useCallback((loaded: ShownRepo) => setShown(loaded), []);
  const [missing, setMissing] = useState<string>();
  // The API checks the session itself; list requests need not wait for display identity.
  const listEarly =
    session.loading &&
    (signedInHint() ||
      route.view === 'repositories' ||
      route.view === 'repo-name' ||
      Boolean(routeRepo(route)));
  const platform = useSource<{ repos: PlatformRepo[] }>(
    session.authenticated || listEarly ? '/repos' : null,
  );
  const orgs = useSource<{ orgs: OrgSummary[] }>(session.authenticated ? '/orgs' : null);
  const activity = useSource<AccountActivity>(
    session.authenticated && (route.view === 'home' || route.view === 'global-search')
      ? '/activity'
      : null,
  );
  // Operators: the sign-up feed, badged in the sidebar with those since this browser looked.
  const { isAdmin, signups, signupsSeen, onSignupsSeen } = useSignups(session.identity);
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
    setAdding(false);
    setPicking(false);
  }, [session.sessionEnded]);
  useEffect(() => {
    if (session.sessionEnded) {
      personalWorkspaceHint(null);
      return;
    }
    if (!session.loading && !session.authenticated) personalWorkspaceHint(null);
    else if (!session.loading && !session.error)
      personalWorkspaceHint(session.identity?.username ?? null);
    if (!session.loading && !session.error) signedInHint(session.authenticated);
  }, [
    session.loading,
    session.error,
    session.authenticated,
    session.identity?.username,
    session.sessionEnded,
  ]);

  async function created(result: Created) {
    // Agents set to run on all repositories pick up the new one; best effort, never waited on.
    void syncAgents(result.owner || session.identity?.username, managedApi);
    platform.reload();
    activity.reload();
    navigate({ view: 'files', repo: result.repo, path: '', ref: 'main' });
    setCreating(false);
    setAdding(false);
  }
  const newOwner =
    route.view === 'org' ? route.org : isAgentsRoute(route) ? route.workspace : undefined;
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
              : isEmailLink(route)
                ? emailLinkTitle(route)
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
  const handleChosen = (handle: string) => {
    setNotice(`Your handle is ${handle}. Your profile is at /${handle}.`);
    forgetRepoNames();
    refresh();
  };
  return {
    session,
    route,
    navigate,
    menuOpen,
    setMenuOpen,
    collapsed,
    setCollapsed,
    signInError,
    setSignInError,
    panel,
    setPanel,
    creating,
    setCreating,
    adding,
    setAdding,
    picking,
    setPicking,
    notice,
    setNotice,
    tick,
    overviewInitial: overviewForNavigation(overviewHandoff, route, viewer, tick, overviewPrincipal),
    overviewViewerKey: viewer,
    overviewPrincipal,
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
    repo,
    row,
    loaded,
    gone,
    site,
    created,
    newOwner,
    title,
    activityError,
    refresh,
    handleChosen,
  };
}

export type AppShell = ReturnType<typeof useAppShell>;
