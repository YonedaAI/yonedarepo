import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, readyReviewer } from './reviewer-fixture';

afterEach(reset);

it.each(['trial', 'resume', 'repair'])('rejects legacy %s before locks or jobs after ordinary workspace funding is configured', async (action) => {
  const f = await readyReviewer(`transition_${action}`);
  await workspace(bindings, f.owner, { op: 'workspace_spend_configure', expected_version: 0, limit_microusd: 50000000 });
  const policy = await workspace(bindings, f.owner, { op: 'reviewer_status' });
  const budget = await workspace(bindings, f.owner, { op: 'workspace_spend_status' });
  const before = await ledger(bindings, f.repo, { op: 'snapshot' });
  const denied = await api(f.scoped, `/api/reviewer/${action}`, f.cookie, { request_id: 'legacy-transition-request-1234', run_id: 'absent-legacy-run' });
  expect(denied.status).toBe(409);
  expect(await denied.json<Json>()).toMatchObject({ error: { code: 'WORKSPACE_WORKFLOW_UPDATED' } });
  expect(await workspace(bindings, f.owner, { op: 'reviewer_status' })).toEqual(policy);
  expect(await workspace(bindings, f.owner, { op: 'workspace_spend_status' })).toEqual(budget);
  const after = await ledger(bindings, f.repo, { op: 'snapshot' });
  for (const key of ['runs', 'executions', 'team_tasks', 'candidates', 'decisions', 'seq']) expect(after[key]).toEqual(before[key]);
  expect((await api(f.scoped, '/api/reviewer', f.cookie)).status).toBe(200);
});
