// "New repository": a platform repository seeded with a README, or (with agent runs) an
// agent project, which starts from the website template or a public Git import and gets
// its own platform repository plus a Runs tab.
import { type FormEvent, useId, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import { sourceApi } from '../source-platform/sourceApi';

export const REPO_NAME_PATTERN = '[A-Za-z0-9_\\-][A-Za-z0-9._\\-]{0,99}';

/** The first commit's README: the name as its title, then the description. */
export function readmeSeed(name: string, description: string) {
  const text = description.trim() ? `# ${name}\n\n${description.trim()}\n` : `# ${name}\n`;
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type Created = { repo: string } | { project: string };

export function NewRepositoryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: Created) => Promise<void>;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [agents, setAgents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hint = useId();
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const description = String(data.get('description') ?? '');
    setBusy(true);
    setError('');
    try {
      if (agents) {
        const source = String(data.get('source') ?? '').trim();
        const project = await api<{ id: string }>('projects', {
          request_id: requestId,
          name,
          ...(source ? { source } : {}),
        });
        await onCreated({ project: project.id });
      } else {
        const created = await sourceApi<{ id: string }>('/repos', {
          body: {
            name,
            policy: { required_checks: [], approvals: 1 },
            files: [{ path: 'README.md', content_b64: readmeSeed(name, description) }],
            author: { name: 'Repository owner', email: 'owner@yonedarepo.invalid' },
          },
        });
        await onCreated({ repo: created.id });
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="New repository"
      onClose={onClose}
      locked={busy}
      initialFocus='input[name="name"]'
    >
      <form className="new-repository" onSubmit={create}>
        <label>
          Repository name
          <input
            name="name"
            required
            maxLength={100}
            pattern={REPO_NAME_PATTERN}
            title="Letters, digits, . _ and -; not starting with a dot"
            placeholder="my-service"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label>
          Description (optional)
          <textarea name="description" maxLength={500} rows={2} disabled={busy} />
        </label>
        <label className="new-repository-option">
          <input
            type="checkbox"
            checked={agents}
            onChange={(e) => setAgents(e.target.checked)}
            aria-describedby={hint}
            disabled={busy}
          />
          <span className="new-repository-text">
            Agent runs
            <small id={hint}>
              Starts from the website template (or a public Git import) and adds a Runs tab where
              hosted agents work on it.
            </small>
          </span>
        </label>
        {agents && (
          <label>
            Public Git URL (optional)
            <input
              name="source"
              type="url"
              placeholder="https://github.com/owner/repository"
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="new-repository-actions">
          <button type="button" className="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create repository'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
