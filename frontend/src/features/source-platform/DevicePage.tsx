// Device login approval (`/device`): `yoneda login` shows a user code; the signed-in owner
// enters it here (or arrives with ?code=), picks scopes, expiry and repositories, and
// approves or denies. The CLI then receives a personal access token; this page never does.
import { type FormEvent, useState } from 'react';
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_PAT_SCOPES,
  isUserCode,
  normalizeUserCode,
  PAT_SCOPES,
  type PatScope,
} from './connect';
import { Failure, Loading } from './SourceStatus';
import { SourceApiError, sourceApi } from './sourceApi';
import { ExpirySelect, RepoAllowlist, type RepoSummary, ScopeChecks } from './TokenParts';
import { useSource } from './useSource';

type Outcome = 'approved' | 'denied';

/** Why an approval failed, in words for the person at the browser. */
export function deviceFailure(error: unknown): string {
  if (error instanceof SourceApiError) {
    if (error.code === 'NOT_FOUND')
      return 'That code is unknown or was already used. Run yoneda login again for a new one.';
    if (error.code === 'EXPIRED_TOKEN')
      return 'That code has expired (codes last 10 minutes). Run yoneda login again.';
  }
  return (error as Error).message;
}

export function DeviceOutcome({ outcome }: { outcome: Outcome }) {
  return (
    <div className="source-shown-once" role="status">
      {outcome === 'approved' ? (
        <>
          <strong>Approved.</strong> Return to your terminal: yoneda login finishes on its own.
        </>
      ) : (
        <>
          <strong>Denied.</strong> The waiting yoneda login receives no token.
        </>
      )}
    </div>
  );
}

export function DevicePage({ code: initial }: { code: string }) {
  const repos = useSource<{ repos: RepoSummary[] }>('/repos');
  const [code, setCode] = useState(initial);
  const [scopes, setScopes] = useState<PatScope[]>(DEFAULT_PAT_SCOPES);
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [allow, setAllow] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function decide(deny: boolean) {
    setBusy(true);
    setError('');
    try {
      await sourceApi('/device/approve', {
        body: {
          user_code: normalizeUserCode(code),
          scopes,
          expires_days: days,
          ...(allow.length ? { repos: allow } : {}),
          ...(deny ? { deny: true } : {}),
        },
      });
      setOutcome(deny ? 'denied' : 'approved');
    } catch (e) {
      setError(deviceFailure(e));
    } finally {
      setBusy(false);
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void decide(false);
  };
  const valid = isUserCode(code);

  return (
    <div className="source-device">
      <h1>Connect a device</h1>
      {repos.loading && !repos.data && <Loading what="your account" />}
      {repos.error && <Failure error={repos.error} onRetry={repos.reload} />}
      {outcome && <DeviceOutcome outcome={outcome} />}
      {repos.data && !outcome && (
        <form onSubmit={submit} className="source-token-form">
          <p>
            Approve only a code that <code>yoneda login</code> just showed you in your own terminal.
            The device receives a personal access token with the access you choose.
          </p>
          <label htmlFor="device-code" className="source-field">
            Code
            <input
              id="device-code"
              value={code}
              onChange={(e) => setCode(normalizeUserCode(e.target.value))}
              placeholder="BCDF-GHJK"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={code !== '' && !valid}
              required
            />
          </label>
          <ScopeChecks legend="Access" options={PAT_SCOPES} value={scopes} onChange={setScopes} />
          <ExpirySelect id="device-expiry" value={days} onChange={setDays} />
          <RepoAllowlist repos={repos.data.repos} value={allow} onChange={setAllow} />
          <div className="source-actions">
            <button type="submit" disabled={busy || !valid || scopes.length === 0}>
              {busy ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy || !valid}
              onClick={() => void decide(true)}
            >
              Deny
            </button>
          </div>
        </form>
      )}
      {error && <Failure error={error} />}
    </div>
  );
}
