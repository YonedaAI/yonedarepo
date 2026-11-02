import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUp } from '../../tools/staging/cli-walk-flow.mjs';

async function cleanup(t, { deleted = 200, after = 401 } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const status = init.method === 'DELETE' ? deleted : after;
    return Response.json(status === 200 ? { revoked: true } : { error: { code: 'UNAUTHORIZED' } }, { status });
  });
  const metrics = {};
  await cleanUp({ api: 'https://platform.example', repos: [], orgs: [], keys: [], tokens: ['test-token'], owner: { get: async () => ({ keys: [] }) } }, metrics);
  return { calls, left: metrics.left_behind };
}

test('cleanup accepts a token already revoked by logout --agent', async (t) => {
  const { left } = await cleanup(t, { deleted: 401 });
  assert.deepEqual(left, []);
});

test('cleanup checks that a revoked login can no longer list repositories', async (t) => {
  const { calls, left } = await cleanup(t);
  assert.deepEqual(left, []);
  assert.deepEqual(calls, ['DELETE /api/v1/device/token', 'GET /api/v1/repos']);
});

test('cleanup fails if the supposedly revoked token still authenticates', async (t) => {
  const { left } = await cleanup(t, { after: 200 });
  assert.equal(left.length, 1);
});

test('cleanup does not treat a forbidden or failed revoke as successful', async (t) => {
  for (const deleted of [403, 500]) {
    const { left } = await cleanup(t, { deleted });
    assert.equal(left.length, 1);
    t.mock.restoreAll();
  }
});

test('an already-revoked response still needs an unauthorized readback', async (t) => {
  const { left } = await cleanup(t, { deleted: 401, after: 403 });
  assert.equal(left.length, 1);
});
