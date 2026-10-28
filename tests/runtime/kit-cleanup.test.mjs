// The kit and the fanout bench delete every repository they create, pass or fail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from '../../tools/fanout-bench/driver.mjs';
import { withRepos } from '../../tools/staging/platform-flow.mjs';

/** A platform Session stand-in: creations get ids, deletions are recorded (or refused). */
function fakePlatform({ refuseDelete = false } = {}) {
  const deleted = [];
  let n = 0;
  return {
    deleted,
    post: async (path, body) => (path === '/repos' ? { id: `r${String(++n).padStart(20, '0')}`, commit: 'c' } : body),
    raw: async (method, path) => {
      assert.equal(method, 'DELETE');
      deleted.push(path);
      return refuseDelete ? { ok: false, status: 403, body: { error: { code: 'FORBIDDEN' } } } : { ok: true, status: 200, body: {} };
    },
  };
}

test('an item deletes the repositories it made when it passes', async () => {
  const platform = fakePlatform();
  const value = await withRepos(platform, async (newRepo) => {
    await newRepo('kit-a', {}, []);
    await newRepo('kit-b', {}, []);
    return 'done';
  });
  assert.equal(value, 'done');
  assert.equal(platform.deleted.length, 2);
  assert.match(platform.deleted[0], /^\/repos\/r0{19}1\?confirm=kit-a-\d+$/);
});

test('a failing item still deletes its repositories and keeps its own error', async () => {
  const platform = fakePlatform({ refuseDelete: true });
  await assert.rejects(
    withRepos(platform, async (newRepo) => {
      await newRepo('kit-a', {}, []);
      throw new Error('the check failed');
    }),
    /the check failed/,
  );
  assert.equal(platform.deleted.length, 1);
});

test('a passing item that leaked a repository fails', async () => {
  const platform = fakePlatform({ refuseDelete: true });
  await assert.rejects(
    withRepos(platform, (newRepo) => newRepo('kit-a', {}, [])),
    /Left repositories: kit-a-\d+ \(403 FORBIDDEN\)/,
  );
});

test('the bench deletes the repositories it created and reports any it could not', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/auth/login') return new Response('{}', { status: 200, headers: { 'set-cookie': 'yr=1; Path=/' } });
    if (init.method === 'POST' && path === '/api/v1/repos') return Response.json({ id: `r${calls.length}` });
    if (init.method === 'DELETE') return Response.json({}, { status: path.includes('/r3?') ? 500 : 200 });
    return Response.json({});
  });
  const session = await connect('https://platform.test', 'https://client.test');
  await session.createRepo('fanout10', []);
  await session.createRepo('fanout20', []);
  const left = await session.cleanup();
  assert.deepEqual(calls.filter((c) => c.startsWith('DELETE')).map((c) => c.replace(/-\d+$/, '')), [
    'DELETE /api/v1/repos/r2?confirm=fanout10',
    'DELETE /api/v1/repos/r3?confirm=fanout20',
  ]);
  assert.equal(left.length, 1);
  assert.match(left[0], /^fanout20-\d+ \(500\)$/);
  assert.deepEqual(await session.cleanup(), [], 'a second cleanup deletes nothing again');
});
