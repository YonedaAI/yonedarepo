import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNeeded, releasePasses, RELEASE_JOBS } from '../../tools/ship/ci-scope.mjs';

test('ordinary docs-only changes skip fast checks, but release/manual and missing history fail safe', () => {
  const docs = ['README.md', 'docs/runbook.md', 'frontend/src/content/docs/start.md'];
  assert.equal(checkNeeded(docs), false);
  assert.equal(checkNeeded(docs, true), true);
  assert.equal(checkNeeded([...docs, 'cloudflare/worker/http.ts']), true);
  assert.equal(checkNeeded(['odd\nfile.ts']), true);
  assert.equal(checkNeeded(null), true);
});

test('the final Ship gate fails for every failed, skipped, cancelled, missing or malformed prerequisite', () => {
  const passed = Object.fromEntries(RELEASE_JOBS.map(id => [id, { result: 'success' }]));
  assert.equal(releasePasses(passed), true);
  for (const id of RELEASE_JOBS) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined])
      assert.equal(releasePasses({ ...passed, [id]: { result } }), false, `${id}/${result}`);
    const missing = { ...passed }; delete missing[id];
    assert.equal(releasePasses(missing), false, id);
  }
  for (const malformed of [null, {}, [], 'success']) assert.equal(releasePasses(malformed), false);
});
