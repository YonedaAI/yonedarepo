// Connect a repository: the clone command and CLI install, the account MCP for agents with
// Claude Code and Codex configuration, and deleting the repository (type its name).
import { type FormEvent, useState } from 'react';
import {
  claudeMcpJson,
  claudePluginSteps,
  cloneCommand,
  codexToml,
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
  onDeleted,
}: {
  repo: string;
  name?: string;
  origin: string;
  onDeleted: () => void;
}) {
  return (
    <div className="source-connect">
      <section aria-labelledby="connect-git">
        <h2 id="connect-git">Clone with git</h2>
        <p className="source-meta">
          Plain git through the yoneda remote helper. <code>git push origin main</code> lands: the
          server merges disjoint concurrent changes.
        </p>
        <CopyBlock label="clone" text={cloneCommand(origin, repo, name)} />
        <CopyBlock label="install the yoneda CLI" text={installSteps(origin)} />
      </section>
      <section aria-labelledby="connect-agents">
        <h2 id="connect-agents">Agents (MCP)</h2>
        <p className="source-meta">
          One endpoint for all your repositories: every tool takes a <code>repo</code> argument.
          Authenticate with a personal access token from <a href="/source/tokens">Tokens</a> in the{' '}
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
      <DeleteRepository repo={repo} name={name} onDeleted={onDeleted} />
    </div>
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
    <section aria-labelledby="connect-delete" className="source-danger">
      <h2 id="connect-delete">Delete repository</h2>
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
