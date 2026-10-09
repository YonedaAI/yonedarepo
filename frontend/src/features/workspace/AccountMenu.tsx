import { ChevronDown, LogOut, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { AccountIdentity } from '../../lib/types';

export function AccountMenu({
  identity,
  onSignOut,
  onError,
}: {
  identity: AccountIdentity | null;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const label =
    identity?.role === 'user'
      ? identity.username
      : identity?.role === 'admin'
        ? 'Administrator'
        : 'Signed in';
  const description =
    identity?.role === 'user'
      ? 'Personal workspace'
      : identity?.role === 'admin'
        ? 'Operator workspace'
        : 'Connected workspace';
  return (
    <details
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
          {identity?.role === 'user' ? label[0]?.toUpperCase() : <UserRound size={16} />}
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
