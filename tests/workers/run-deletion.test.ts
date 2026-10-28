import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { projectPlatform } from '../../cloudflare/worker/agents-platform';
import { deliverRunDeletion } from '../../cloudflare/worker/run-deletion';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { api, bindings, readyReviewer } from './reviewer-fixture';
import { approvedLedger, oneAgent } from './source-kit';

afterEach(reset);

it('deletes a cancelled run through the owner route, then its archive and attempt branches', async () => {
  const f = await readyReviewer('run_delete_owner');
  const repo = f.repo;
  await approvedLedger(bindings, repo)({ op: 'start_run', id: 'old-run', intent: 'Old attempt', agents: oneAgent });
  const active = await api(f.scoped, `/api/repos/${repo}/delete_run`, f.cookie, { run_id: 'old-run' });
  expect(active.status).toBe(409);
  expect((await active.json<Json>()).error.code).toBe('INVALID_STATE');
  await ledger(bindings, repo, { op: 'cancel_run', run_id: 'old-run' });
  // What the sandbox pushed for this run, and what the archive wrote for it.
  const platform = await projectPlatform(bindings, f.owner, repo);
  await platform.call('POST', '/refs/batch', { updates: [{ ref: 'refs/heads/attempts/old-run/1', commit: f.head, expected: null }] });
  const archive = `history/${repo}/old-run.json`;
  await bindings.OBJECTS.put(archive, '{}');

  const deleted = await api(f.scoped, `/api/repos/${repo}/delete_run`, f.cookie, { run_id: 'old-run' });
  expect(deleted.status).toBe(200);
  expect(await deleted.json<Json>()).toEqual({ run_id: 'old-run', deleted: true });
  expect((await (await api(f.scoped, `/api/repos/${repo}/runs`, f.cookie)).json<Json>()).items).toEqual([]);
  const again = await api(f.scoped, `/api/repos/${repo}/delete_run`, f.cookie, { run_id: 'old-run' });
  expect((await again.json<Json>()).error.code).toBe('NOT_FOUND');

  const { jobs } = await ledger(bindings, repo, { op: 'outbox' });
  const entry = jobs.find((job: Json) => job.kind === 'run_delete');
  await deliverRunDeletion(bindings, repo, entry);
  expect(await bindings.OBJECTS.get(archive)).toBeNull();
  const { refs } = await platform.call('GET', '/refs');
  expect(refs['refs/heads/attempts/old-run/1']).toBeUndefined();
  expect(refs['refs/heads/main']).toBe(f.head);
  await expect(deliverRunDeletion(bindings, repo, { ...entry, payload: { ...entry.payload, archive_key: 'history/other/old-run.json' } })).rejects.toThrow('identity mismatch');
});
