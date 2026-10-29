// The shell's top bar: the navigation menu (phones), the page title, Getting started, the
// theme, refresh and the account menu.
import { Menu, Moon, RefreshCw, Sun, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AccountIdentity } from '../../lib/types';
import type { Theme } from '../shell/theme';
import type { Navigate } from '../shell/useRoute';
import { AccountMenu } from './AccountMenu';

export function WorkspaceHeader({
  title,
  loading,
  onRefresh,
  authenticated,
  identity,
  navigate = () => {},
  menuOpen = false,
  onMenu,
  theme = 'dark',
  onTheme,
  progress,
  onConnect,
  onSignIn,
  onSignOut,
  onError,
}: {
  /** The current page or repository. */
  title: string;
  loading: boolean;
  onRefresh: () => void;
  authenticated: boolean;
  identity: AccountIdentity | null;
  navigate?: Navigate;
  /** The phone navigation menu is open. */
  menuOpen?: boolean;
  onMenu?: () => void;
  theme?: Theme;
  onTheme?: (theme: Theme) => void;
  /** The Getting started meter, while steps remain. */
  progress?: ReactNode;
  onConnect?: () => void;
  onSignIn: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
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
        <p className="topbar-title">{title}</p>
      </div>
      <div className="header-actions">
        {progress}
        {onTheme && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Use the ${next} theme`}
            title={`Use the ${next} theme`}
            onClick={() => onTheme(next)}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        )}
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
