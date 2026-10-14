import { expect, it } from 'vitest';
import { invalidateSourceSession } from '../../cloudflare/worker/source-invalidation';
import type { Scope } from '../../cloudflare/worker/types';

const scope = { job: { id: 'job:source', epoch: 2, payload: { workspace_transport: 'api-source-v1' },
  source_mounts: [{ path: 'repo' }] } } as Scope;
const input = { alias: 'repo', paths: ['src/main.rs'], job_id: 'job:source', epoch: 2 };
it('requires the current lease and exact root acknowledgement before a model mutation can be acknowledged', async () => {
  const order: string[] = [];
  const result = await invalidateSourceSession(scope, input,
    async () => { order.push('lease'); }, async (request) => { order.push('invalidate'); return { ...request, invalidated: true }; });
  expect(order).toEqual(['lease', 'invalidate']);
  expect(result.invalidated).toBe(true);
  await expect(invalidateSourceSession(scope, input, async () => { throw Object.assign(new Error('fenced'), { code: 'FENCED' }); },
    async () => { throw new Error('Must not reach supervisor'); })).rejects.toMatchObject({ code: 'FENCED' });
  await expect(invalidateSourceSession(scope, input, async () => {}, async () => ({ invalidated: true, ...input, epoch: 3 })))
    .rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
});
it('rejects forged attempts, mount aliases, traversal and extra fields before any root request', async () => {
  for (const forged of [{ ...input, epoch: 3 }, { ...input, job_id: 'foreign' }, { ...input, alias: 'candidate-0' },
    { ...input, paths: ['../secret'] }, { ...input, paths: ['.git/config'] }, { ...input, token: 'forged' }]) {
    await expect(invalidateSourceSession(scope, forged, async () => { throw new Error('Must not validate'); },
      async () => { throw new Error('Must not send'); })).rejects.toMatchObject({ code: 'SOURCE_SCOPE' });
  }
});
