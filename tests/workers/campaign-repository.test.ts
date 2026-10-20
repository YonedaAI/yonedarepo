import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import { api, bindings, readyReviewer } from './reviewer-fixture';

afterEach(reset);
it('lets the operator prepare an explicitly owned campaign without weakening reviewer or tenant scope', async () => {
  const f = await readyReviewer('operator_scope');
  const request = (action: string, input = {}, username = f.owner, admin = true) => api(f.scoped, '/api/admin/campaign/repository', admin ? '' : f.cookie, { username, repo_id: f.repo, action, input }, admin);
  const initial = await request('snapshot');
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ repository: { workspace: f.owner }, runs: [] });
  expect((await request('snapshot', {}, 'foreign_owner')).status).toBe(403);
  expect((await request('snapshot', {}, f.owner, false)).status).toBe(403);
  expect((await request('start_run')).status).toBe(404);
  expect((await request('finish')).status).toBe(404);
  const created = await request('create_working_branch', { id: 'working', expected_commit: f.head, expected_version: 0, _workspace: 'foreign_owner', actor: 'forged', campaign: { id: 'forged' } });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ id: 'working', working_commit: f.head });
  expect((await ledger(bindings, f.repo, { op: 'snapshot' })).runs).toEqual([]);
});
