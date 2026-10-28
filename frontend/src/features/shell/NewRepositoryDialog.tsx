// "New repository": a platform repository seeded with a README.
import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { sourceApi } from '../source-platform/sourceApi';

export const REPO_NAME_PATTERN = '[A-Za-z0-9_\\-][A-Za-z0-9._\\-]{0,99}';

/** The first commit's README: the name as its title, then the description. */
export function readmeSeed(name: string, description: string) {
  const text = description.trim() ? `# ${name}\n\n${description.trim()}\n` : `# ${name}\n`;
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type Created = { repo: string };

export function NewRepositoryDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: Created) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const description = String(data.get('description') ?? '');
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ id: string }>('/repos', {
        body: {
          name,
          policy: { required_checks: [], approvals: 1 },
          files: [{ path: 'README.md', content_b64: readmeSeed(name, description) }],
          author: { name: 'Repository owner', email: 'owner@yonedarepo.invalid' },
        },
      });
      await onCreated({ repo: created.id });
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
