import { useState } from 'react';
import { api } from '../../lib/api';
import type { Repository } from '../../lib/types';
export function RepositoryRecovery({
  repository,
  onChange,
  onError,
}: {
  repository: Repository;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (repository.status !== 'blocked') return null;
  return (
    <section className="publication-banner" role="status">
      <div>
        <strong>Publication needs recovery</strong>
        <p>
          Read the current canonical Git revision and reconcile this sandbox. The failed decision
          remains in the evidence trail.
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          onError('');
          try {
            await api(`repos/${repository.id}/resync_repository`, {
              expected_version: repository.version,
              expected_pending: repository.pending,
            });
            await onChange();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Reading canonical Git…' : 'Recover repository'}
      </button>
    </section>
  );
}
