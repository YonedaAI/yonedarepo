// The shell's top bar: the navigation menu (phones), the page's breadcrumbs (where it has a
// parent, breadcrumbs.ts) or its title, Getting started, the theme (cycles System, Light,
// Dark), refresh and the account menu.
import { Menu, Monitor, Moon, RefreshCw, Sun, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AccountIdentity } from '../../lib/types';
import { nextTheme, THEMES, useTheme } from '../shell/theme';
import { linkTo, type Navigate } from '../shell/useRoute';
import { formatSourceRoute } from '../source-platform/sourceRoute';
import { AccountMenu } from './AccountMenu';
import type { Crumb } from './breadcrumbs';

export function WorkspaceHeader({
  title,
  crumbs,
  loading,
  onRefresh,
  authenticated,
  identity,
  navigate = () => {},
  menuOpen = false,
  onMenu,
  progress,
  onConnect,
  onSignIn,
  onSignOut,
  onError,
}: {
  /** The current page or repository. */
  title: string;
  /** The way back to this page's parents; shown instead of the title. */
  crumbs?: Crumb[] | null;
  loading: boolean;
  onRefresh: () => void;
  authenticated: boolean;
  identity: AccountIdentity | null;
  navigate?: Navigate;
  /** The phone navigation menu is open. */
  menuOpen?: boolean;
  onMenu?: () => void;
  /** The Getting started meter, while steps remain (in the account menu on a phone). */
  progress?: ReactNode;
  onConnect?: () => void;
  onSignIn: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [theme, setTheme] = useTheme();
  const label = (id: string) => THEMES.find((t) => t.id === id)?.label;
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const switchTo = `Theme: ${label(theme)}. Switch to ${label(nextTheme(theme))}`;
  return (
    <header className="workspace-header">
      <div className="topbar-start">
        {onMenu && (
          <button
            type="button"
            className="icon-button topbar-menu"
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            onClick={onMenu}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        )}
        {crumbs?.length ? (
          <nav aria-label="Breadcrumb" className="topbar-crumbs">
            <ol>
              {crumbs.map((crumb, i) => (
                // A link's address, else the current page's label (never starts with "/").
                <li key={crumb.to ? formatSourceRoute(crumb.to) : crumb.label}>
                  {i === crumbs.length - 1 || !crumb.to ? (
                    <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  ) : (
                    <a {...linkTo(crumb.to, navigate)}>{crumb.label}</a>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : (
          <p className="topbar-title">{title}</p>
        )}
      </div>
      <div className="header-actions">
        {progress && <span className="topbar-progress">{progress}</span>}
        <button
          type="button"
          className="icon-button"
          aria-label={switchTo}
          title={switchTo}
          onClick={() => setTheme(nextTheme(theme))}
        >
          <Icon size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Refresh ${title}`}
          title="Refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
        {authenticated ? (
          <AccountMenu
            identity={identity}
            progress={progress}
            navigate={navigate}
            onConnect={onConnect}
            onSignOut={onSignOut}
            onError={onError}
          />
        ) : (
          <button type="button" className="quiet" disabled={loading} onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}
