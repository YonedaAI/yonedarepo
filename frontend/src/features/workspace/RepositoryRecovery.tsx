import { useState } from 'react';
import { api, short } from '../../lib/api';
import type { Repository } from '../../lib/types';
import { pendingLanding, publishOnPlatform } from '../exploration/platformPublication';

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
  const pending = pendingLanding(
    repository,
    decisions.find((item) => item.id === repository.pending),
  );
  if (pending && repository.pending) {
    const decisionId = repository.pending;
    return (
      <section className="publication-banner" role="status">
        <div>
          <strong>Publication is waiting for you</strong>
          <p>
            {`You selected ${short(pending.commit)}. Approve and land it on the project's platform repository to publish it.`}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void guarded(async () => {
              await publishOnPlatform(repository.id, decisionId, pending);
            })
          }
        >
          {busy ? 'Publishing…' : 'Publish'}
        </button>
      </section>
    );
  }
  if (repository.status !== 'blocked') return null;
  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    onError('');
    try {
      await work();
      await onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const run = (action: string, body: Record<string, unknown>) =>
    guarded(async () => {
      await api(`repos/${repository.id}/${action}`, body);
    });
  return (
    <section className="publication-banner" role="status">
      <div>
        <strong>Publication needs recovery</strong>
        <p>
          Read the platform repository&apos;s current main and reconcile this project. The failed
          decision remains in the evidence trail.
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run('resync_repository', {
            expected_version: repository.version,
            expected_pending: repository.pending,
          })
        }
      >
        {busy ? 'Reading the platform…' : 'Recover repository'}
      </button>
    </section>
  );
}
