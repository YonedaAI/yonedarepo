import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNeeded, onlyTooling, validationScope, changedPaths, releasePasses, RELEASE_JOBS } from '../../tools/ship/ci-scope.mjs';

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
  passed.scope.outputs = { tooling: 'false', full: 'true' };
  assert.equal(releasePasses(passed), true);
  for (const id of RELEASE_JOBS) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined])
      assert.equal(releasePasses({ ...passed, [id]: { result } }), false, `${id}/${result}`);
    const missing = { ...passed }; delete missing[id];
    assert.equal(releasePasses(missing), false, id);
  }
  for (const malformed of [null, {}, [], 'success']) assert.equal(releasePasses(malformed), false);
});


test('tooling mode accepts only the explicit non-application inventory and fails closed', () => {
  const tooling = ['xtask/src/deploy.rs', '.github/workflows/ci.yml', 'tools/ci/workers.mjs', 'tools/ship/ci-scope.mjs', 'tests/runtime/ship-workflows.test.mjs', 'docs/ship-pipeline.md', 'README.md'];
  assert.equal(onlyTooling(tooling), true);
  for (const path of ['backend/a.rs', 'cloudflare/a.ts', 'frontend/a.ts', 'shared/a.ts', 'infra/envs/dev.json', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'pnpm-lock.yaml', 'tools/staging/a.mjs', 'unknown', 'xtask/../backend/a.rs', 'docs/odd\nname.md'])
    assert.equal(onlyTooling([...tooling, path]), false, path);
  for (const paths of [null, [], undefined, ['backend/readme.md']]) assert.equal(onlyTooling(paths), false);
  assert.deepEqual(validationScope(tooling, { release: true }), { tooling: true, full: false });
  assert.deepEqual(validationScope(tooling, { release: true, manualFull: true }), { tooling: false, full: true });
  assert.deepEqual(validationScope(null, { release: true }), { tooling: false, full: true });
  assert.deepEqual(validationScope(['frontend/a.ts'], {}), { tooling: false, full: false });
});

test('Git discovery uses the actual compared trees, includes deletions on rename and rejects missing history', () => {
  let args;
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  assert.deepEqual(changedPaths(base, head, (_command, values) => { args = values; return Buffer.from('backend/removed.rs\0docs/renamed.md\0'); }), ['backend/removed.rs', 'docs/renamed.md']);
  assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', base, head]);
  assert.equal(changedPaths(undefined, head), null);
  assert.equal(changedPaths(base, head, () => { throw Error('missing history'); }), null);
});

test('tooling release permits only deliberately skipped full jobs and successful mandatory checks', () => {
  const tooling = Object.fromEntries(RELEASE_JOBS.map(id => [id, { result: ['scope', 'ship-tree', 'check'].includes(id) ? 'success' : 'skipped' }]));
  tooling.scope.outputs = { tooling: 'true', full: 'false' };
  assert.equal(releasePasses(tooling), true);
  for (const id of RELEASE_JOBS) {
    for (const result of ['failure', 'cancelled', undefined, id === 'check' ? 'skipped' : 'success']) {
      if (result === tooling[id].result) continue;
      assert.equal(releasePasses({ ...tooling, [id]: { ...tooling[id], result } }), false, `${id}/${result}`);
    }
  }
  for (const outputs of [{}, { tooling: 'true', full: 'true' }, { tooling: 'false', full: 'false' }])
    assert.equal(releasePasses({ ...tooling, scope: { result: 'success', outputs } }), false);
});
