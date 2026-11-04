import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { workerSuites, workerInvocation } from '../../tools/ci/workers.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inventory = readdirSync(resolve(root, 'tests/workers'), { recursive: true })
  .filter(path => path.endsWith('.test.ts')).map(path => `tests/workers/${path}`);
const compatibility = ['tests/workers/repo-favorites.test.ts', 'tests/workers/repo-readable-paths.test.ts'];
const manual = ['tests/workers/load-platform.test.ts', 'tests/workers/repo-big-fetch.test.ts'];

test('every actual Worker test has one routine owner except intentional compatibility and scale cases', () => {
  const suites = workerSuites(inventory);
  assert.deepEqual(suites.manual, manual);
  assert.deepEqual(suites.main.filter(path => suites.platform.includes(path)), compatibility);
  assert.deepEqual([...new Set(Object.values(suites).flat())].sort(), [...inventory].sort());
  for (const path of inventory) {
    const lanes = Object.keys(suites).filter(lane => suites[lane].includes(path));
    assert.equal(lanes.length, compatibility.includes(path) ? 2 : 1, path);
  }
  assert(suites.platform.includes('tests/workers/repo-api.test.ts'));
  assert(suites.main.includes('tests/workers/account-signup-email.test.ts'));
  assert(suites.main.includes('tests/workers/oauth.test.ts'));
});

test('new repository and evaluation tests enter platform; other new tests enter main', () => {
  const suites = workerSuites(['tests/workers/future/repo-new.test.ts', 'tests/workers/eval-future.test.ts', 'tests/workers/repo-future.test.ts', 'tests/workers/new-adapter.test.ts']);
  assert.deepEqual(suites.platform, ['tests/workers/eval-future.test.ts', 'tests/workers/repo-future.test.ts']);
  assert.deepEqual(suites.main, ['tests/workers/future/repo-new.test.ts', 'tests/workers/new-adapter.test.ts']);
  assert.deepEqual(suites.manual, []);
});

test('runner forwards selected files and arguments from another cwd without launching Vitest', () => {
  const bin = mkdtempSync(resolve(tmpdir(), 'yoneda-ci-selector-'));
  writeFileSync(resolve(bin, 'pnpm'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
  chmodSync(resolve(bin, 'pnpm'), 0o755);
  try {
  for (const lane of ['main', 'platform']) {
    const plan = workerInvocation(lane, inventory, ['--shard=1/4', '--reporter=json']);
    assert.equal(plan.command, 'pnpm');
    assert.equal(plan.args[0], lane === 'platform' ? 'test:platform' : 'test');
    assert.deepEqual(plan.args.slice(1, -2), workerSuites(inventory)[lane]);
    assert.deepEqual(plan.args.slice(-2), ['--shard=1/4', '--reporter=json']);
    assert.equal(resolve(plan.options.cwd), resolve(root));
    assert.equal(plan.options.shell, false);
    const result = spawnSync(process.execPath, [resolve(root, 'tools/ci/workers.mjs'), lane, '--shard=1/4', '--reporter=json'], { cwd: '/tmp', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: resolve(root), args: plan.args });
  }
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('unknown lanes and empty, duplicate or malformed inventories fail before launching', () => {
  assert.throws(() => workerInvocation('manual', inventory), /lane/);
  for (const files of [[], null, ['tests/workers/a.test.ts', 'tests/workers/a.test.ts'], ['../outside.test.ts'], ['tests/workers/../a.test.ts'], ['tests/workers/a.ts'], ['tests/workers/a\0.test.ts']])
    assert.throws(() => workerSuites(files), /inventory/);
  assert.throws(() => workerInvocation('platform', ['tests/workers/new-adapter.test.ts']), /empty/);
  const result = spawnSync(process.execPath, [resolve(root, 'tools/ci/workers.mjs'), 'unknown'], { cwd: '/tmp', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lane/);
});
