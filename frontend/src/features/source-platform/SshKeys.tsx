// Settings → SSH keys: the account's public keys for Git over SSH. Adding one makes
// clone, fetch and push over SSH act as this account; deleting it refuses that key at once.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { SettingsRow, SettingsSection } from '../../components/SettingsSection';
import { Failure, Loading } from './SourceStatus';
import { sourceApi, when } from './sourceApi';
import { publicKeyProblem, type SshAccess, type SshKey, suggestedTitle } from './sshKeyModel';
import { type Loaded, useSource } from './useSource';

export function SshKeyTable({
  keys,
  onDelete,
}: {
  keys: Loaded<{ keys: SshKey[] }>;
  onDelete: (key: SshKey) => void;
}) {
  if (keys.loading && !keys.data) return <Loading what="SSH keys" />;
  if (keys.error) return <Failure error={keys.error} onRetry={keys.reload} />;
  const list = keys.data?.keys ?? [];
  if (list.length === 0) return <p className="source-empty">No SSH keys yet.</p>;
  return (
    <div className="source-table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Fingerprint</th>
            <th>Added</th>
            <th>Last used</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id}>
              <td>{k.title}</td>
              <td>
                <code title={k.algorithm}>{k.fingerprint}</code>
              </td>
              <td>{when(k.created_at)}</td>
              <td>{k.last_used_at ? when(k.last_used_at) : 'never'}</td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => onDelete(k)}
                  aria-label={`Delete SSH key ${k.title}`}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How to use a key: the tunnel's one-time client setup, then the clone URL. */
export function SshSetup({ access }: { access?: SshAccess }) {
  if (!access) return null;
  if (!access.host)
    return (
      <p className="source-meta">Git over SSH is not open yet; use HTTPS with a token meanwhile.</p>
    );
  return (
    <div className="source-meta">
      {access.ssh_config && (
        <>
          <p>
            Git over SSH goes through Cloudflare Tunnel. Once per machine,{' '}
            <a href="https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/">
              install cloudflared
            </a>{' '}
            and add this to <code>~/.ssh/config</code>:
          </p>
          <pre>{access.ssh_config}</pre>
        </>
      )}
      <p>
        Then clone with <code>{access.clone_url}</code>.
      </p>
    </div>
  );
}

/** The new-key form; `onAdded` re-reads the list. */
export function SshKeyDialog({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problem = publicKeyProblem(key);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (problem) return;
    setBusy(true);
    setError('');
    try {
      await sourceApi<SshKey>('/ssh-keys', {
        body: { title: title.trim() || suggestedTitle(key) || 'ssh key', key: key.trim() },
      });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Add SSH key" onClose={onClose} locked={busy} initialFocus="#ssh-key">
      <form onSubmit={add} className="source-token-form">
        <p className="source-meta">
          Paste the contents of a <code>.pub</code> file, for example{' '}
          <code>~/.ssh/id_ed25519.pub</code>, or run{' '}
          <code>yoneda ssh-key add ~/.ssh/id_ed25519.pub</code>.
        </p>
        <label htmlFor="ssh-title" className="source-field">
          Title
          <input
            id="ssh-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={suggestedTitle(key) || 'laptop, build server'}
            maxLength={64}
          />
        </label>
        <label htmlFor="ssh-key" className="source-field source-field-wide">
          Public key
          <textarea
            id="ssh-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="ssh-ed25519 AAAA… you@host"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            required
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? 'ssh-key-problem' : undefined}
          />
        </label>
        {problem && (
          <p id="ssh-key-problem" role="alert" className="source-error">
            {problem}
          </p>
        )}
        {error && <Failure error={error} />}
        <div className="run-actions">
          <button type="submit" disabled={busy || !key.trim() || Boolean(problem)}>
            {busy ? 'Adding…' : 'Add SSH key'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SshKeys() {
  const keys = useSource<{ keys: SshKey[]; ssh?: SshAccess }>('/ssh-keys');
  const access = keys.data?.ssh;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  async function remove(k: SshKey) {
    if (!window.confirm(`Delete SSH key ${k.title}? Git over SSH with it stops immediately.`))
      return;
    setError('');
    try {
      await sourceApi(`/ssh-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      keys.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <SettingsSection id="ssh" title="Your keys">
        <SettingsRow
          title="Git over SSH"
          detail="Clone, fetch and push over SSH as this account."
          action={
            <button type="button" className="quiet" onClick={() => setAdding(true)}>
              Add SSH key
            </button>
          }
        />
        {adding && (
          <SshKeyDialog
            onClose={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              keys.reload();
            }}
          />
        )}
        <SshKeyTable keys={keys} onDelete={remove} />
        {error && (
          <div className="settings-block">
            <Failure error={error} />
          </div>
        )}
      </SettingsSection>
      {access && (
        <SettingsSection id="ssh-setup" title="Set up">
          <div className="settings-block">
            <SshSetup access={access} />
          </div>
        </SettingsSection>
      )}
    </>
  );
}
