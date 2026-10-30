// Connect a repository: its clone commands, the CLI install and the account MCP for agents
// with Claude Code and Codex configuration; and deleting a repository (type its name).
import { type FormEvent, useState } from 'react';
import {
  CLAUDE_PLUGIN_COMMAND,
  claudeMarketplaceCommand,
  claudeMcpJson,
  cloneCommand,
  codexToml,
  httpsCloneCommand,
  installCommand,
  loginCommand,
  mcpUrl,
} from './connect';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { CopyBlock } from './TokenParts';

/** The two clone commands, the recommended yoneda remote helper first, each with what it
 * needs: the helper a one-time `yoneda login`, stock Git a personal token as the password. */
export function CloneCommands({
  repo,
  name,
  origin,
}: {
  repo: string;
  name?: string;
  origin: string;
}) {
  return (
    <>
      <CopyBlock
        label="yoneda remote helper (recommended)"
        text={cloneCommand(origin, repo, name)}
      />
      <p className="source-meta clone-hint">
        Run once: <code>{loginCommand(origin)}</code> — then pull/push use your login.
      </p>
      <CopyBlock
        label="HTTPS (needs a personal token as the password)"
        text={httpsCloneCommand(origin, repo, name)}
      />
      <p className="source-meta clone-hint">
        <a href="/settings/tokens">Settings → Personal tokens</a>
      </p>
    </>
  );
}

export function ConnectPanel({
  repo,
  name,
  origin,
}: {
  repo: string;
  name?: string;
  origin: string;
}) {
  return (
    <div className="source-connect">
      <section aria-labelledby="connect-git">
        <h2 id="connect-git">Clone with git</h2>
        <p className="source-meta">
          The yoneda remote helper, or stock Git over HTTPS with a personal token as the password.{' '}
          <code>git push origin main</code> lands: the server merges disjoint concurrent changes.
        </p>
        <CloneCommands repo={repo} name={name} origin={origin} />
        <p className="source-meta">
          Repository id <code>{repo}</code>
        </p>
      </section>
      <AgentConnectHelp origin={origin} />
    </div>
  );
}

/** The yoneda CLI and the account MCP endpoint, for agents across every repository. */
export function AgentConnectHelp({ origin }: { origin: string }) {
  return (
    <>
      <section aria-labelledby="connect-cli">
        <h2 id="connect-cli">The yoneda CLI</h2>
        <p className="source-meta">
          Installs <code>yoneda</code> and <code>git-remote-yoneda</code> into{' '}
          <code>~/.local/bin</code> on macOS and Linux. Signing in opens your browser to approve;
          the token is stored with mode 0600.
        </p>
        <CopyBlock label="Install the yoneda CLI" text={installCommand(origin)} />
        <CopyBlock label="Sign in" text={loginCommand(origin)} />
      </section>
      <section aria-labelledby="connect-agents">
        <h2 id="connect-agents">Agents (MCP)</h2>
        <p className="source-meta">
          One endpoint for all your repositories: every tool takes a <code>repo</code> argument.
          Authenticate with a personal access token from <a href="/settings/tokens">Settings</a> in
          the <code>YONEDA_TOKEN</code> environment variable.
        </p>
        <CopyBlock label="MCP URL" text={mcpUrl(origin)} />
        <CopyBlock
          label="Claude Code: add the marketplace"
          text={claudeMarketplaceCommand(origin)}
        />
        <CopyBlock label="Claude Code: install the plugin" text={CLAUDE_PLUGIN_COMMAND} />
        <CopyBlock
          label="Claude Code .mcp.json (without the plugin)"
          text={claudeMcpJson(origin)}
        />
        <CopyBlock label="Codex ~/.codex/config.toml" text={codexToml(origin)} />
      </section>
    </>
  );
}

export function DeleteRepository({
  repo,
  name,
  onDeleted,
}: {
  repo: string;
  name?: string;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const expected = name ?? repo;
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (typed !== expected) return;
    setBusy(true);
    setError('');
    try {
      await sourceApi(`/repos/${repo}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="delete-heading" className="source-danger">
      <h2 id="delete-heading">Delete repository</h2>
      <p>
        Deleting removes its history, refs and tokens for everyone. It cannot be undone. Type{' '}
        <strong>{expected}</strong> to confirm.
      </p>
      <form onSubmit={remove} className="source-create">
        <label htmlFor="delete-confirm" className="sr-only">
          Repository name
        </label>
        <input
          id="delete-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="danger" disabled={busy || typed !== expected}>
          {busy ? 'Deleting…' : 'Delete this repository'}
        </button>
      </form>
      {error && <Failure error={error} />}
    </section>
  );
}
