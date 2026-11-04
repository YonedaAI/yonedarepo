import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoPath } from '../../tools/staging/repo-urls.mjs';

test('page address discovery requests metadata once without storage diagnostics', async () => {
  const id = `r${'1'.repeat(20)}`;
  const calls = [];
  const account = { get: async (path) => {
    calls.push(path);
    if (path !== `/api/v1/repos/${id}?summary=true`)
      throw new Error('Full storage status is unavailable');
    return { path: '/owner/project' };
  } };
  assert.equal(await repoPath(account, id), '/owner/project');
  assert.equal(await repoPath(account, id), '/owner/project');
  assert.deepEqual(calls, [`/api/v1/repos/${id}?summary=true`]);
});

test('metadata without an owner handle keeps the id-based page address', async () => {
  const id = `r${'2'.repeat(20)}`;
  const account = { get: async (path) => {
    assert.equal(path, `/api/v1/repos/${id}?summary=true`);
    return { path: null };
  } };
  assert.equal(await repoPath(account, id), `/source/${id}`);
});

test('failed metadata reads remain failures and are not cached', async () => {
  const id = `r${'3'.repeat(20)}`;
  let calls = 0;
  const failure = new Error('Metadata unavailable');
  const account = { get: async () => {
    if (++calls === 1) throw failure;
    return { path: '/owner/recovered' };
  } };
  await assert.rejects(repoPath(account, id), (error) => error === failure);
  assert.equal(await repoPath(account, id), '/owner/recovered');
  assert.equal(calls, 2);
});
