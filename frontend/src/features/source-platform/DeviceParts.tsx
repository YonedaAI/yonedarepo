// The pieces of the device card (DevicePage.tsx): what the person checks, the grant behind
// Options, and the code when the address didn't bring one.
import { useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import { isUserCode, normalizeUserCode, PAT_SCOPES, type PatScope } from './connect';
import { ExpirySelect, RepoAllowlist, type RepoSummary, ScopeChecks } from './TokenParts';

/** The grant a person can change; the defaults are what Approve sends without opening this. */
export function DeviceOptions({
  repos,
  scopes,
  days,
  allow,
  busy,
  onChange,
  onDeny,
}: {
  repos: RepoSummary[];
  scopes: PatScope[];
  days: number;
  allow: string[];
  busy: boolean;
  onChange: (next: Partial<{ scopes: PatScope[]; days: number; allow: string[] }>) => void;
  onDeny: () => void;
}) {
  return (
    <div className="device-options">
      <ScopeChecks
        legend="Access"
        options={PAT_SCOPES}
        value={scopes}
        onChange={(next) => onChange({ scopes: next })}
      />
      <ExpirySelect id="device-expiry" value={days} onChange={(next) => onChange({ days: next })} />
      <RepoAllowlist repos={repos} value={allow} onChange={(next) => onChange({ allow: next })} />
      <button type="button" className="quiet" disabled={busy} onClick={onDeny}>
        Deny
      </button>
    </div>
  );
}

/** Who, which machine and which code: what the person checks before approving. */
export function Asking({
  identity,
  host,
  code,
}: {
  identity?: AccountIdentity | null;
  host?: string | null;
  code: string;
}) {
  return (
    <>
      <dl className="device-facts">
        <dt>Signed in as</dt>
        <dd>{identity?.handle ?? identity?.username}</dd>
        {host && (
          <>
            <dt>This machine</dt>
            <dd>{host}</dd>
          </>
        )}
        <dt>Code</dt>
        <dd>
          <code>{code}</code>
        </dd>
      </dl>
      <p className="device-hint">Check this code matches your terminal.</p>
    </>
  );
}

/** Asks for the code `yoneda login` showed, when the address didn't bring it. */
export function CodeEntry({ onCode }: { onCode: (code: string) => void }) {
  const [typed, setTyped] = useState('');
  return (
    <label htmlFor="device-code" className="source-field device-code-entry">
      Code from your terminal
      <input
        id="device-code"
        value={typed}
        onChange={(e) => {
          const next = normalizeUserCode(e.target.value);
          setTyped(next);
          if (isUserCode(next)) onCode(next);
        }}
        placeholder="BCDF-GHJK"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}
