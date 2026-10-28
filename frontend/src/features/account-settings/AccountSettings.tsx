// Account settings (`/settings`, from the account menu): the account, the CLIs signed in
// with `yoneda login`, personal access tokens and organizations.
import { useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import type { Navigate } from '../shell/useRoute';
import { AccountOrgs } from '../source-platform/AccountOrgs';
import { expiresIn } from '../source-platform/connect';
import type { OrgSummary } from '../source-platform/orgModel';
import {
  isDeviceLogin,
  onlyTokens,
  type Pat,
  PersonalTokens,
  revokePat,
} from '../source-platform/PersonalTokens';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import type { RepoSummary } from '../source-platform/TokenParts';
import { type Loaded, useSource } from '../source-platform/useSource';

export function CliTable({
  tokens,
  onSignOut,
  now = Date.now(),
}: {
  tokens: Loaded<{ tokens: Pat[] }>;
  onSignOut: (token: Pat) => void;
  now?: number;
}) {
  if (tokens.loading && !tokens.data) return <Loading what="signed-in CLIs" />;
  if (tokens.error) return <Failure error={tokens.error} onRetry={tokens.reload} />;
  const list = tokens.data?.tokens ?? [];
  if (list.length === 0)
    return (
      <p className="source-empty">
        No CLI is signed in. Run <code>yoneda login</code> and approve it here.
      </p>
    );
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Signed in</th>
            <th>Last used</th>
            <th>Expires</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{when(t.created_at)}</td>
              <td>{t.last_used_at ? when(t.last_used_at) : 'never'}</td>
              <td>{expiresIn(t.expires_at, now)}</td>
              <td>
                <button type="button" className="quiet" onClick={() => onSignOut(t)}>
                  Sign out
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccountSettings({
  identity,
  repos,
  orgs,
  navigate,
}: {
  identity: AccountIdentity | null;
  /** The account's repositories by name, for a token's repository allowlist. */
  repos: RepoSummary[];
  /** The account's organizations (the shell's copy, so the sidebar follows a new one). */
  orgs?: Loaded<{ orgs: OrgSummary[] }>;
  navigate?: Navigate;
}) {
  const tokens = useSource<{ tokens: Pat[] }>('/tokens');
  const [error, setError] = useState('');
  const clis = onlyTokens(tokens, isDeviceLogin);
  return (
    <div className="account-settings source-tokens">
      <h1>Settings</h1>
      <section aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        {identity ? (
          <dl className="settings-facts">
            <dt>Account name</dt>
            <dd>
              <code>{identity.username}</code>
            </dd>
            <dt>Git and API</dt>
            <dd>
              Clone and push as this account with a personal token as the password, or sign the CLI
              in with <code>yoneda login</code>.
            </dd>
          </dl>
        ) : (
          <p className="source-meta">Sign in to see it.</p>
        )}
      </section>
      <section aria-labelledby="cli-heading">
        <h2 id="cli-heading">Signed-in CLIs</h2>
        <p className="source-meta">
          Each <code>yoneda login</code> you approved holds a personal token named after the client.
          Signing one out revokes its token.
        </p>
        <CliTable
          tokens={clis}
          onSignOut={async (t) => {
            setError('');
            try {
              await revokePat(t, tokens, 'That CLI and its agents');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
        {error && <Failure error={error} />}
      </section>
      <PersonalTokens repos={repos} orgs={orgs?.data?.orgs} tokens={tokens} />
      {orgs && navigate && <AccountOrgs orgs={orgs} navigate={navigate} />}
    </div>
  );
}
