// The narrow icon rail: Browse (Home), the open repository's Changes and Search (the
// repository list when none is open), New repository, and the sidebar's collapse toggle.
import { GitPullRequest, House, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { routeRepo, routeTab, type SourceRoute } from '../source-platform/sourceRoute';
import { linkTo, type Navigate } from './useRoute';

export function AppRail({
  authenticated,
  route,
  collapsed,
  onToggle,
  navigate,
  onNew,
}: {
  authenticated: boolean;
  route: SourceRoute;
  /** The sidebar is hidden. */
  collapsed: boolean;
  onToggle: () => void;
  navigate: Navigate;
  onNew: () => void;
}) {
  const repo = routeRepo(route);
  const page = routeTab(route);
  const elsewhere: SourceRoute = authenticated ? { view: 'repositories' } : { view: 'explore' };
  const item = (on: boolean) => `rail-item${on ? ' active' : ''}`;
  return (
    <nav className="rail" aria-label="Shortcuts">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a className="rail-mark" aria-label="YonedaRepo home" {...linkTo({ view: 'home' }, navigate)}>
        y
      </a>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: linkTo spreads the href, so this is a link. */}
      <a
        className={item(!repo && route.view !== 'explore')}
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
        className={item(page === 'search')}
        aria-label="Search"
        title={repo ? 'Search this repository' : 'Find a repository'}
        {...linkTo(repo ? { view: 'search', repo, query: '' } : elsewhere, navigate)}
      >
        <Search size={18} aria-hidden="true" />
      </a>
      {authenticated && (
        <button
          type="button"
          className="rail-item"
          aria-label="New repository"
          title="New repository"
          onClick={onNew}
        >
          <Plus size={18} aria-hidden="true" />
        </button>
      )}
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
