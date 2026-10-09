import { useState } from 'react';
import { api } from '../../lib/api';
export function NewProject({
  onCreated,
  onClose,
}: {
  onCreated: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <h2>Add a repository</h2>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        Start with a static website, or import a public Git repository. Your source lives in
        Cloudflare Artifacts. You can edit the build and check commands before approving a run.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          try {
            const name = String(data.get('name') ?? '').trim();
            if (!name || new TextEncoder().encode(name).length > 100)
              throw new Error(
                'Choose a repository name of 1–100 bytes. Use a shorter name if it includes non-ASCII characters.',
              );
            const result = await api<{ id: string }>('projects', {
              request_id: requestId,
              name,
              source: data.get('source'),
            });
            await onCreated(result.id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Repository name
          <input name="name" required maxLength={100} placeholder="my-website" disabled={busy} />
        </label>
        <label>
          Public Git URL (optional)
          <input
            name="source"
            type="url"
            placeholder="https://github.com/owner/repository"
            disabled={busy}
            aria-describedby="source-requirements"
          />
        </label>
        <p id="source-requirements" className="subtle">
          Imports must be public and have a commit on their default branch. Empty repositories
          cannot be imported. Leave the URL blank to start from the website template.
        </p>
        <button type="submit" disabled={busy}>
          {busy ? 'Requesting repository setup…' : 'Create repository'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
