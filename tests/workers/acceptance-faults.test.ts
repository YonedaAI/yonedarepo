import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { injectPublicationAckLoss } from '../../cloudflare/worker/acceptance-faults';
import type { Env, Scope } from '../../cloudflare/worker/types';

function scope(repo = `acceptance-${crypto.randomUUID()}`): Scope {
  return { repo_id: repo, supervisor: 'not-a-real-token', created_at: Date.now(), model_calls: 0,
    job: { id: 'publish-fixture', epoch: 1, kind: 'publish', payload: { target: { commit: 'a'.repeat(40) } } } };
}

it('cannot activate acknowledgement loss in production namespaces or ordinary repositories', async () => {
  const enabled = { ...env, ACCEPTANCE_FAULTS: 'publish-ack-once', ARTIFACTS_NAMESPACE: 'yoneda-dev' } as unknown as Env;
  expect(await injectPublicationAckLoss(enabled, scope(), { commit: 'a'.repeat(40) })).toBe(false);
  expect(await injectPublicationAckLoss({ ...enabled, ARTIFACTS_NAMESPACE: 'isolated-acceptance' }, scope('reviewer-sandbox'), { commit: 'a'.repeat(40) })).toBe(false);
});

it('uses an atomic real R2 marker so concurrent callbacks lose only one acknowledgement', async () => {
  const isolated = { ...env, ACCEPTANCE_FAULTS: 'publish-ack-once', ARTIFACTS_NAMESPACE: 'isolated-acceptance' } as unknown as Env;
  const attempt = scope();
  const results = await Promise.all([
    injectPublicationAckLoss(isolated, attempt, { commit: 'a'.repeat(40) }),
    injectPublicationAckLoss(isolated, attempt, { commit: 'a'.repeat(40) }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await injectPublicationAckLoss(isolated, { ...attempt, job: { ...attempt.job, epoch: 2 } }, { commit: 'a'.repeat(40), recovered: true })).toBe(false);
});

it('does not inject before a successful publication result or for another capability', async () => {
  const isolated = { ...env, ACCEPTANCE_FAULTS: 'publish-ack-once', ARTIFACTS_NAMESPACE: 'isolated-acceptance' } as unknown as Env;
  const attempt = scope();
  expect(await injectPublicationAckLoss(isolated, attempt, { conflict: true })).toBe(false);
  expect(await injectPublicationAckLoss(isolated, { ...attempt, job: { ...attempt.job, kind: 'agent' } }, { commit: 'a'.repeat(40) })).toBe(false);
});
