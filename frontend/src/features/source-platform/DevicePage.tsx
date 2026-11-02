// Device login approval (`/device`), on its own with no app around it: `yoneda login` shows a
// code and a link; the person lands here, signs in if they must, sees who they are, which machine
// asks and the same code as their terminal, and approves. The link alone approves nothing: a
// person has to press Approve with the code in front of them, on a page that says to close the tab
// if this wasn't them. The CLI then receives a personal access token; this page never does.
// Scopes, expiry and repositories sit behind Options, and `yoneda login --agent <name>` has its
// own grant fields (DeviceAgent.tsx).
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import { AccountPanel } from '../workspace/AccountPanel';
import { DEFAULT_EXPIRY_DAYS, DEVICE_PAT_SCOPES, isUserCode, normalizeUserCode } from './connect';
import {
  AGENT_DEFAULT_SCOPES,
  AgentFields,
  type AgentForm,
  agentGrant,
  agentProblem,
} from './DeviceAgent';
import { Asking, CodeEntry, DeviceOptions } from './DeviceParts';
import { Failure, Loading } from './SourceStatus';
import { SourceApiError, sourceApi } from './sourceApi';
import type { RepoSummary } from './TokenParts';
import { useSource } from './useSource';

type Outcome = 'approved' | 'denied';

const TITLE = 'Sign in to YonedaRepo';

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

/** The page: a card in the middle, with nothing of the app around it. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — YonedaRepo`;
  }, [title]);
  return (
    <main className="device-page">
      <section className="device-card" aria-labelledby="device-title">
        <img className="device-logo" src="/brand/mark.svg" alt="" width="40" height="40" />
        <h1 id="device-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** Where the login stands once it is decided: the card, and one line. */
export function DeviceDone({ outcome }: { outcome: Outcome }) {
  return outcome === 'approved' ? (
    <Card title="Signed in">
      <p role="status">You're signed in. You can close this tab and return to your terminal.</p>
    </Card>
  ) : (
    <Card title="Sign-in denied">
      <p role="status">The waiting yoneda login receives no token. You can close this tab.</p>
    </Card>
  );
}

function Approval({
  code,
  site,
  identity,
}: {
  code: string;
  site: string;
  identity?: AccountIdentity | null;
}) {
  const repos = useSource<{ repos: RepoSummary[] }>('/repos');
  const pending = useSource<{ agent: string | null; host: string | null }>(
    `/device/pending?code=${code}`,
  );
  const [options, setOptions] = useState(false);
  const [grant, setGrant] = useState({
    scopes: DEVICE_PAT_SCOPES,
    days: DEFAULT_EXPIRY_DAYS,
    allow: [] as string[],
  });
  const [form, setForm] = useState<AgentForm>({
    scopes: AGENT_DEFAULT_SCOPES,
    days: DEFAULT_EXPIRY_DAYS,
    all: false,
    repos: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const agent = pending.data?.agent ?? null;

  async function decide(deny: boolean) {
    setBusy(true);
    setError('');
    try {
      await sourceApi('/device/approve', {
        body: {
          user_code: code,
          ...(agent
            ? agentGrant(form)
            : {
                scopes: grant.scopes,
                expires_days: grant.days,
                ...(grant.allow.length ? { repos: grant.allow } : {}),
              }),
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
  if (outcome) return <DeviceDone outcome={outcome} />;
  const ready = agent ? !agentProblem(form) : grant.scopes.length > 0;
  const refused = pending.error
    ? deviceFailure(new SourceApiError(pending.code ?? '', pending.error, pending.errorStatus ?? 0))
    : '';
  const list = repos.data?.repos ?? [];
  return (
    <Intro site={site}>
      {(pending.loading || (repos.loading && !repos.data)) && <Loading what="your account" />}
      {refused && <Failure error={refused} />}
      {repos.error && !refused && <Failure error={repos.error} onRetry={repos.reload} />}
      {repos.data && pending.data && (
        <form onSubmit={submit} className="device-form">
          <Asking identity={identity} host={pending.data.host} code={code} />
          {agent && (
            <AgentFields
              agent={agent}
              host={pending.data.host}
              repos={list}
              form={form}
              onChange={(next) => setForm({ ...form, ...next })}
            />
          )}
          <button type="submit" disabled={busy || !ready}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
          {!agent && (
            <button type="button" className="device-link" onClick={() => setOptions(!options)}>
              {options ? 'Hide options' : 'Options'}
            </button>
          )}
          {options && !agent && (
            <DeviceOptions
              repos={list}
              {...grant}
              busy={busy}
              onChange={(next) => setGrant({ ...grant, ...next })}
              onDeny={() => void decide(true)}
            />
          )}
        </form>
      )}
      {error && <Failure error={error} />}
    </Intro>
  );
}

/** The card's words, around whatever this step asks. */
function Intro({ children, site }: { children: ReactNode; site: string }) {
  return (
    <Card title={TITLE}>
      <p>You're signing the CLI into:</p>
      <code className="device-host">{site}</code>
      {children}
      <p className="device-footer">If you didn't start this from your terminal, close this tab.</p>
    </Card>
  );
}

export function DevicePage({
  code: initial,
  site = window.location.origin,
  session,
  signInError,
}: {
  code: string;
  /** The site being signed into. */
  site?: string;
  session: {
    authenticated: boolean;
    loading: boolean;
    identity?: AccountIdentity | null;
    discover: () => Promise<void>;
  };
  /** A provider sign-in that came back here refused, in words. */
  signInError?: string;
}) {
  const normalized = normalizeUserCode(initial);
  const [code, setCode] = useState(isUserCode(normalized) ? normalized : '');
  if (session.loading)
    return (
      <Intro site={site}>
        <Loading what="your account" />
      </Intro>
    );
  if (!session.authenticated)
    return (
      <Intro site={site}>
        <AccountPanel
          initialMode="login"
          initialError={signInError}
          onMode={() => {}}
          onConnected={() => void session.discover()}
        />
      </Intro>
    );
  if (!code)
    return (
      <Intro site={site}>
        <CodeEntry onCode={setCode} />
      </Intro>
    );
  return <Approval code={code} site={site} identity={session.identity} />;
}
