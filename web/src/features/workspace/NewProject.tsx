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
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          try {
            const result = await api<{ id: string }>('projects', {
              request_id: requestId,
              name: data.get('name'),
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
          <input name="name" required maxLength={120} placeholder="my-website" />
        </label>
        <label>
          Public Git URL (optional)
          <input name="source" type="url" placeholder="https://github.com/owner/repository" />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Creating repository…' : 'Create repository'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
