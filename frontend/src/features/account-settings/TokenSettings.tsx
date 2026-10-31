// Settings → Tokens (`/settings/tokens`): personal access tokens, then the CLIs signed in with
// `yoneda login`. A login is a personal token too, so both read one list.
import { useState } from 'react';
import { SettingsSection } from '../../components/SettingsSection';
import { expiresIn } from '../source-platform/connect';
import type { OrgSummary } from '../source-platform/orgModel';
import {
  isDeviceLogin,
  onlyTokens,
  type Pat,
  PersonalTokens,
} from '../source-platform/PersonalTokens';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { when } from '../source-platform/sourceApi';
import type { RepoSummary } from '../source-platform/TokenParts';
import { revokePat } from '../source-platform/tokenRevoke';
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
            <th>Host</th>
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
              <td>{t.host ?? 'unknown host'}</td>
              <td>{when(t.created_at)}</td>
              <td>{t.last_used_at ? when(t.last_used_at) : 'never'}</td>
              <td>{expiresIn(t.expires_at, now)}</td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Sign out ${t.host ?? t.name}`}
                  onClick={() => onSignOut(t)}
                >
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

export function TokenSettings({
  repos,
  orgs,
}: {
  /** The account's repositories by name, for a token's repository allowlist. */
  repos: RepoSummary[];
  orgs?: OrgSummary[];
}) {
  const tokens = useSource<{ tokens: Pat[] }>('/tokens');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const clis = onlyTokens(tokens, isDeviceLogin);
  return (
    <>
      <PersonalTokens repos={repos} orgs={orgs} tokens={tokens} />
      <SettingsSection id="cli" title="Signed-in CLIs">
        <p className="source-meta settings-block">
          Each <code>yoneda login</code> you approved holds a personal token, labelled with its
          machine. Signing one out revokes its token and removes the SSH keys it added.
        </p>
        <CliTable
          tokens={clis}
          onSignOut={async (t) => {
            setError('');
            setNotice('');
            try {
              setNotice((await revokePat(t, tokens, 'That CLI and its agents')) ?? '');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
        {notice && (
          <p className="source-meta settings-block" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div className="settings-block">
            <Failure error={error} />
          </div>
        )}
      </SettingsSection>
    </>
  );
}
