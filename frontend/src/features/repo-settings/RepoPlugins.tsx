// Settings → Plugins: installed plugins (the managed agents, AgentHero) and suggested ones.
// Installing AgentHero creates a scoped repository token and a webhook through the platform
// API, then shows the token, the signing secret and the MCP address once, to paste into
// AgentHero. Uninstalling revokes the token and deletes the webhook.
import { type FormEvent, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { currentApiOrigin } from '../source-platform/connect';
import type { RepoToken } from '../source-platform/RepoTokens';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { sourceApi, when } from '../source-platform/sourceApi';
import { CopyBlock } from '../source-platform/TokenParts';
import { useSource } from '../source-platform/useSource';
import type { Hook } from './HookParts';
import {
  agentHeroHookBody,
  agentHeroTokenBody,
  type InstalledPlugin,
  installedPlugins,
  isInstalled,
  repoMcpUrl,
  SUGGESTED,
  tokenScopes,
  validHookUrl,
} from './pluginsModel';

type Installed = { token: string; secret: string; mcp: string };

export function RepoPlugins({ repo, navigate }: { repo: string; navigate: Navigate }) {
  const tokens = useSource<{ tokens: RepoToken[] }>(`/repos/${repo}/tokens`);
  const hooks = useSource<{ hooks: Hook[] }>(`/repos/${repo}/hooks`);
  const [installing, setInstalling] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<Installed>();

  if ((tokens.loading && !tokens.data) || (hooks.loading && !hooks.data))
    return <Loading what="plugins" />;
  const failed = tokens.error ?? hooks.error;
  if (failed)
    return (
      <Failure
        error={failed}
        what="plugins"
        onRetry={() => {
          tokens.reload();
          hooks.reload();
        }}
      />
    );
  const allTokens = tokens.data?.tokens ?? [];
  const installed = installedPlugins(allTokens, hooks.data?.hooks ?? []);
  const suggested = SUGGESTED.filter((p) => !isInstalled(installed, p.id));

  async function install(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const tokenBody = agentHeroTokenBody(allTokens);
    try {
      const token = await sourceApi<{ token: string }>(`/repos/${repo}/tokens`, {
        body: tokenBody,
      });
      const hook = await sourceApi<{ secret: string }>(`/repos/${repo}/hooks`, {
        body: agentHeroHookBody(url),
      }).catch(async (e) => {
        // Leave nothing half installed: the token goes when its webhook could not be made.
        await sourceApi(`/repos/${repo}/tokens/${encodeURIComponent(tokenBody.name)}`, {
          method: 'DELETE',
        }).catch(() => {});
        throw e;
      });
      setShown({
        token: token.token,
        secret: hook.secret,
        mcp: repoMcpUrl(currentApiOrigin(), repo),
      });
      setInstalling(false);
      setUrl('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      tokens.reload();
      hooks.reload();
    }
  }

  async function uninstall(plugin: Extract<InstalledPlugin, { id: 'agenthero' }>) {
    const hookText = plugin.hook ? ` and delete its webhook to ${plugin.hook.url}` : '';
    if (
      !window.confirm(
        `Uninstall AgentHero? This revokes the token ${plugin.token.name}${hookText}. AgentHero stops receiving events immediately.`,
      )
    )
      return;
    setError('');
    try {
      await sourceApi(`/repos/${repo}/tokens/${encodeURIComponent(plugin.token.name)}`, {
        method: 'DELETE',
      });
      if (plugin.hook)
        await sourceApi(`/repos/${repo}/hooks/${plugin.hook.id}`, { method: 'DELETE' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      tokens.reload();
      hooks.reload();
    }
  }

  return (
    <section aria-labelledby="plugins-heading" className="repo-plugins">
      <h2 id="plugins-heading">Plugins</h2>
      <p className="source-meta">
        Plugins work as clients of this repository: each gets its own scoped token and, when it
        needs events, a webhook. Uninstalling removes both.
      </p>

      {shown && (
        <div className="source-shown-once" role="status">
          <strong>AgentHero is installed. Copy these now; they will not be shown again.</strong>
          <CopyBlock label="repository token" text={shown.token} />
          <CopyBlock label="webhook signing secret" text={shown.secret} />
          <CopyBlock label="MCP address" text={shown.mcp} />
          <button type="button" onClick={() => setShown(undefined)}>
            I saved them
          </button>
        </div>
      )}

      <h3>Installed</h3>
      {installed.length === 0 ? (
        <p className="source-empty">No plugins installed.</p>
      ) : (
        <ul className="plugin-list" aria-label="Installed plugins">
          {installed.map((plugin) => (
            <li key={plugin.id} className="plugin-row">
              <div>
                <strong>{plugin.name}</strong>
                <span className="source-meta">
                  {' '}
                  token {plugin.token.name} ({tokenScopes(plugin.token)}) ·{' '}
                  {when(plugin.token.created_at)}
                </span>
                {plugin.id === 'agenthero' && (
                  <p className="source-meta">
                    {plugin.hook ? `Webhook: ${plugin.hook.url}` : 'No webhook found for it.'}
                  </p>
                )}
              </div>
              {plugin.id === 'managed' ? (
                <a {...linkTo({ view: 'agents', repo, section: 'managed' }, navigate)}>
                  Manage agents
                </a>
              ) : (
                <button type="button" className="quiet" onClick={() => uninstall(plugin)}>
                  Uninstall
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>Suggested</h3>
      {suggested.length === 0 ? (
        <p className="source-empty">Every suggested plugin is installed.</p>
      ) : (
        <ul className="plugin-list" aria-label="Suggested plugins">
          {suggested.map((plugin) => (
            <li key={plugin.id} className="plugin-row">
              <div>
                <strong>{plugin.name}</strong>
                <span className="source-meta"> {plugin.summary}</span>
                <p className="source-meta">{plugin.detail}</p>
              </div>
              {!installing && (
                <button type="button" onClick={() => setInstalling(true)}>
                  Install
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {installing && (
        <form onSubmit={install} className="source-token-form" aria-label="Install AgentHero">
          <label htmlFor="agenthero-url" className="source-field settings-wide">
            AgentHero webhook URL
            <input
              id="agenthero-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://agenthero.example.com/hooks/…"
              aria-describedby="agenthero-url-help"
              required
            />
            <span id="agenthero-url-help" className="source-meta">
              Where AgentHero receives this repository&apos;s change, branch and check events (https
              only).
            </span>
          </label>
          <div className="plugin-actions">
            <button type="submit" disabled={busy || !validHookUrl(url)}>
              {busy ? 'Installing…' : 'Install AgentHero'}
            </button>
            <button type="button" className="quiet" onClick={() => setInstalling(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
