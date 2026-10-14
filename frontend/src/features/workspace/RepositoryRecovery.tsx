import { useState } from 'react';
import { api, short } from '../../lib/api';
import type { Repository } from '../../lib/types';
import { retryablePublication } from './publicationRetry';

export function RepositoryRecovery({
  repository,
  decisions = [],
  onChange,
  onError,
}: {
  repository: Repository;
  decisions?: Record<string, any>[];
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (repository.status !== 'blocked') return null;
  const retry = retryablePublication(repository, decisions);
  async function run(action: string, body: Record<string, unknown>) {
    setBusy(true);
    onError('');
    try {
      await api(`repos/${repository.id}/${action}`, body);
      await onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publication-banner" role="status">
      <div>
        <strong>
          {retry ? 'Publication was blocked by a remote conflict' : 'Publication needs recovery'}
        </strong>
        <p>
          {retry
            ? `The canonical remote still holds ${short(repository.published_commit)}, the revision recorded when you decided. Retry publication re-reads the remote and publishes only if it is unchanged; the conflict stays in the evidence trail.`
            : 'Read the current canonical Git revision and reconcile this sandbox. The failed decision remains in the evidence trail.'}
        </p>
      </div>
      {retry && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run('recover_publication', {
              request_id: crypto.randomUUID(),
              decision_id: retry.id,
              expected_version: repository.version,
            })
          }
        >
          {busy ? 'Reading canonical Git…' : 'Retry publication'}
        </button>
      )}
      <button
        type="button"
        className={retry ? 'quiet' : undefined}
        disabled={busy}
        onClick={() =>
          void run('resync_repository', {
            expected_version: repository.version,
            expected_pending: repository.pending,
          })
        }
      >
        {busy ? 'Reading canonical Git…' : 'Recover repository'}
      </button>
    </section>
  );
}
