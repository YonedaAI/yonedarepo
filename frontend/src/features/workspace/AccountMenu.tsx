import { ChevronDown, LogOut, PlugZap, Settings, UserRound } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import { ThemePicker } from '../shell/ThemePicker';
import { linkTo, type Navigate } from '../shell/useRoute';

export function AccountMenu({
  identity,
  navigate,
  onConnect,
  onSignOut,
  onError,
}: {
  identity: AccountIdentity | null;
  /** Account settings and the CLI/MCP help; absent where the shell offers neither. */
  navigate?: Navigate;
  onConnect?: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const closed = (then: () => void) => () => {
    if (menu.current) menu.current.open = false;
    then();
  };
  const label = identity?.username ?? 'Signed in';
  const description = 'Personal workspace';
  return (
    <details
      ref={menu}
      className="account-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={`Account: ${label}`} title={`Signed in as ${label}`}>
        <span className="account-avatar" aria-hidden="true">
          {identity ? label[0]?.toUpperCase() : <UserRound size={16} />}
        </span>
        <span className="account-label">
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="account-dropdown">
        <p>
          Signed in as <strong>{label}</strong>
          <small>{description}</small>
        </p>
        {navigate && (
          <a
            {...linkTo({ view: 'settings' }, (route) => closed(() => navigate(route))())}
            className="account-item"
          >
            <Settings size={15} aria-hidden="true" />
            Settings
          </a>
        )}
        {onConnect && (
          <button type="button" onClick={closed(onConnect)}>
            <PlugZap size={15} aria-hidden="true" />
            Connect agents (CLI, MCP)
          </button>
        )}
        <ThemePicker />
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSignOut();
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <LogOut size={15} />
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </details>
  );
}
