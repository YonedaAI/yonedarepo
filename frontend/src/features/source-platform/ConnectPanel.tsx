// Connect a repository: its clone commands, the CLI install and the account MCP for agents
// with Claude Code and Codex configuration; and deleting a repository (type its name).
import { type FormEvent, useState } from 'react';
import {
  claudeMcpJson,
  claudePluginSteps,
  cloneCommand,
  codexToml,
  httpsCloneCommand,
  installSteps,
  mcpUrl,
} from './connect';
import { Failure } from './SourceStatus';
import { sourceApi } from './sourceApi';
import { CopyBlock } from './TokenParts';

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
          Stock Git over HTTPS with a token as the password, or the yoneda remote helper.{' '}
          <code>git push origin main</code> lands: the server merges disjoint concurrent changes.
        </p>
        <CopyBlock label="HTTPS" text={httpsCloneCommand(origin, repo, name)} />
        <CopyBlock label="clone" text={cloneCommand(origin, repo, name)} />
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
        <CopyBlock label="install the yoneda CLI" text={installSteps(origin)} />
      </section>
      <section aria-labelledby="connect-agents">
        <h2 id="connect-agents">Agents (MCP)</h2>
        <p className="source-meta">
          One endpoint for all your repositories: every tool takes a <code>repo</code> argument.
          Authenticate with a personal access token from <a href="/settings">Settings</a> in the{' '}
          <code>YONEDA_TOKEN</code> environment variable.
        </p>
        <CopyBlock label="MCP URL" text={mcpUrl(origin)} />
        <CopyBlock label="Claude Code plugin" text={claudePluginSteps()} />
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
