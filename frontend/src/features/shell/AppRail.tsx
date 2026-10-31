// The narrow icon rail: Browse (Home), the open repository's Changes (the repository list when
// none is open), the Search page, the + menu, and the sidebar's collapse toggle.
import { GitPullRequest, House, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { routeRepo, routeTab, type SourceRoute } from '../source-platform/sourceRoute';
import { NewMenu } from './NewMenu';
import { linkTo, type Navigate } from './useRoute';

export function AppRail({
  authenticated,
  route,
  missing = false,
  collapsed,
  onToggle,
  navigate,
  onNew,
  onImport,
}: {
  authenticated: boolean;
  route: SourceRoute;
  /** The open repository is gone: Changes goes to the repository list. */
  missing?: boolean;
  /** The sidebar is hidden. */
  collapsed: boolean;
  onToggle: () => void;
  navigate: Navigate;
  onNew: () => void;
  onImport: () => void;
}) {
  const repo = missing ? undefined : routeRepo(route);
  const page = routeTab(route);
  const elsewhere: SourceRoute = authenticated ? { view: 'repositories' } : { view: 'explore' };
  const searching = route.view === 'global-search';
  const item = (on: boolean) => `rail-item${on ? ' active' : ''}`;
  return (
    <nav className="rail" aria-label="Shortcuts">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a className="rail-mark" aria-label="YonedaRepo home" {...linkTo({ view: 'home' }, navigate)}>
        y
      </a>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a
        className={item(!repo && !searching && route.view !== 'explore')}
        aria-label="Browse"
        title="Browse"
        {...linkTo({ view: 'home' }, navigate)}
      >
        <House size={18} aria-hidden="true" />
      </a>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a
        className={item(page === 'changes')}
        aria-label="Changes"
        title={repo ? 'Changes' : 'Changes (choose a repository)'}
        {...linkTo(repo ? { view: 'changes', repo } : elsewhere, navigate)}
      >
        <GitPullRequest size={18} aria-hidden="true" />
      </a>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a
        className={item(searching)}
        aria-label="Search"
        title="Search"
        {...linkTo({ view: 'global-search' }, navigate)}
      >
        <Search size={18} aria-hidden="true" />
      </a>
      {authenticated && <NewMenu onCreate={onNew} onImport={onImport} />}
      <button
        type="button"
        className="rail-item rail-toggle"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        onClick={onToggle}
      >
        {collapsed ? (
          <PanelLeftOpen size={18} aria-hidden="true" />
        ) : (
          <PanelLeftClose size={18} aria-hidden="true" />
        )}
      </button>
    </nav>
  );
}
