// Application layout; state and route content live in the shell modules.
import { AppRail } from './features/shell/AppRail';
import { AppSidebar } from './features/shell/AppSidebar';
import { GettingStarted } from './features/shell/GettingStarted';
import { GitHubImportDialog } from './features/shell/GitHubImportDialog';
import { NewRepositoryDialog } from './features/shell/NewRepositoryDialog';
import { repoHome } from './features/shell/PickerPanel';
import { CrumbSwitcher } from './features/shell/RepoPicker';
import { saveCollapsed } from './features/shell/theme';
import { useAppShell } from './features/shell/useAppShell';
import { WorkspaceContent } from './features/shell/WorkspaceContent';
import { SiteEntry } from './features/site/SiteEntry';
import { DevicePage } from './features/source-platform/DevicePage';
import { repoNameOf } from './features/source-platform/repoNames';
import { breadcrumbs } from './features/workspace/breadcrumbs';
import { HandlePrompt } from './features/workspace/HandlePicker';
import { WorkspaceHeader } from './features/workspace/WorkspaceHeader';
import { WorkspacePanels } from './features/workspace/WorkspacePanels';

export function App() {
  const shell = useAppShell();
  const {
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
    platform,
    orgs,
    activity,
    isAdmin,
    signups,
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
    refresh,
    handleChosen,
  } = shell;
  if (site)
    return (
      <SiteEntry
        // A refused provider sign-in that landed on the public home shows the sign-in page.
        site={signInError && site.page === 'home' ? { page: 'signin', mode: 'login' } : site}
        session={session}
        navigate={navigate}
        signInError={signInError}
      />
    );
  if (route.view === 'device')
    return <DevicePage code={route.code} session={session} signInError={signInError} />;
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
        onNew={() => {
          setMenuOpen(false);
          setCreating(true);
        }}
        onImport={(publicAddress) => {
          setMenuOpen(false);
          setAdding(publicAddress ? 'public' : true);
        }}
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
        insights={loaded?.insights}
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
          crumbs={breadcrumbs(
            route,
            session.identity?.username,
            { owner: repo ? repoNameOf(repo)?.owner : undefined, name: row?.name ?? loaded?.name },
            session.identity?.handle ?? undefined,
          )}
          switcher={
            <CrumbSwitcher
              rows={rows}
              current={repo}
              currentName={row?.name ?? loaded?.name}
              loading={platform.loading}
              error={rowsError}
              favorites={session.authenticated ? favorites : undefined}
              navigate={navigate}
            />
          }
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
        <WorkspaceContent shell={shell} />
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
          initialOwner={newOwner}
          onClose={() => setCreating(false)}
          onCreated={created}
        />
      )}
      {adding && (
        <GitHubImportDialog
          account={session.identity?.username}
          orgs={orgs.data?.orgs ?? []}
          initialOwner={newOwner}
          repos={platform.data?.repos ?? []}
          publicAddress={adding === 'public'}
          onClose={() => setAdding(false)}
          onImported={created}
          onOpen={(repo) => {
            navigate(repoHome(repo));
            setAdding(false);
          }}
        />
      )}
      <HandlePrompt identity={creating || adding ? null : session.identity} onSet={handleChosen} />
    </div>
  );
}
