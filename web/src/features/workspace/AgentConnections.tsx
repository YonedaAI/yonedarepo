import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

type Grant = { id: string; label: string; scope: string; expires: number; revoked: boolean };
export function AgentConnections({ repo, onClose }: { repo: string; onClose: () => void }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [issued, setIssued] = useState<{ token: string; mcp_url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setGrants((await api<{ grants: Grant[] }>(`repos/${repo}/grants`)).grants);
  }, [repo]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <h2>Connect a local agent</h2>
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        Give Codex, Claude Code or another MCP client a key for this repository. Read keys explore
        source and context. Contribution keys also author typed context and push to isolated forks.
        Human selection is required to publish.
      </p>
      {issued ? (
        <>
          <h3>Save this key privately</h3>
          <p>
            This key is shown once. Set it in your shell as YONEDA_MCP_TOKEN; keep it out of source
            control and prompts.
          </p>
          <code className="recovery-code">{issued.token}</code>
          <p>MCP endpoint</p>
          <code className="recovery-code">{issued.mcp_url}</code>
          <details>
            <summary>Claude Code project configuration (.mcp.json)</summary>
            <pre>
              {JSON.stringify(
                {
                  mcpServers: {
                    yoneda: {
                      type: 'http',
                      url: issued.mcp_url,
                      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands this at launch.
                      headers: { Authorization: 'Bearer ${YONEDA_MCP_TOKEN}' },
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
          </details>
          <details>
            <summary>Codex configuration (~/.codex/config.toml)</summary>
            <pre>{`[mcp_servers.yoneda]\nurl = "${issued.mcp_url}"\nbearer_token_env_var = "YONEDA_MCP_TOKEN"`}</pre>
          </details>
          <p>
            Ask your agent to read repo_context, search prior alternatives, then use attempt_begin
            to build a follow-up. The tool returns a scoped Git URL. Push its default branch,
            publish findings and call attempt_submit.
          </p>
          <button type="button" onClick={() => setIssued(null)}>
            I saved the key
          </button>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError('');
            try {
              setIssued(
                await api(`repos/${repo}/grants`, {
                  label: data.get('label'),
                  scope: data.get('scope'),
                  days: Number(data.get('days')),
                }),
              );
              await load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Agent name
            <input name="label" required maxLength={120} placeholder="Laptop Codex" />
          </label>
          <label>
            Access
            <select name="scope">
              <option value="read">Read source and context</option>
              <option value="contribute">Read and contribute changes</option>
            </select>
          </label>
          <label>
            Expires after (days)
            <input name="days" type="number" min={1} max={31} defaultValue={7} required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create agent key'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <h3>Repository keys</h3>
      {grants.length ? (
        <ul>
          {grants.map((g) => (
            <li key={g.id}>
              <strong>{g.label}</strong> {g.scope} —{' '}
              {g.revoked ? 'revoked' : `expires ${new Date(g.expires).toLocaleDateString()}`}
              {!g.revoked && (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`repos/${repo}/grants`, { revoke: g.id });
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No agent keys created.</p>
      )}
    </section>
  );
}
