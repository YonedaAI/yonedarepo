import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { initialCommit, policy } from './comparison-review-fixture';

const bindings = env as unknown as Env;
afterEach(reset);

it('returns a structured missing-run owner review error through the real router without creating work or spend', async () => {
  const owner = 'comparison_router_user', repo = 'comparison-router-boundary';
  const signup = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://yoneda' },
    body: JSON.stringify({ username: owner, password: 'Synthetic router contract password' }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Owner review router boundary',
    workspace: owner, remote: { namespace: 'yoneda-test', name: repo }, commit: initialCommit, policy });
  const before = await ledger(bindings, repo, { op: 'snapshot' });
  const allowance = await workspace(bindings, owner, { op: 'workspace_spend_status' });
  const result = await bindings.SELF.fetch(`https://yoneda/api/repos/${repo}/approve_comparison_review`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://yoneda', cookie: cookie! },
    body: JSON.stringify({ run_id: 'nonexistent-run-no-paid-work', request_id: 'missing-run-contract',
      expected_commit: initialCommit, expected_version: 0, expected_policy_version: policy.version }),
  });
  expect(result.status).toBe(409);
  expect(result.headers.get('content-type')).toContain('application/json');
  expect(await result.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  expect(await ledger(bindings, repo, { op: 'snapshot' })).toEqual(before);
  expect(await workspace(bindings, owner, { op: 'workspace_spend_status' })).toEqual(allowance);
});
