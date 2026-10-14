import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateFile, safeOrigin } from './credentials.mjs';
import { parseArgs } from '../guided-acceptance.mjs';
import { briefs, guidedBriefs, guidedPolicy, protectedBundle } from './profile.mjs';
import {
  guidedBuildIntent,
  guidedExtendIntent,
  guidedConcurrentIntents,
  guidedIntents,
} from '../../shared/guided-runs.ts';
import { canonicalBundle } from '../../cloudflare/worker/test-bundle.ts';
import { createHash } from 'node:crypto';

test('keys cannot enter arguments, insecure origins, readable files or symlink aliases', async () => {
  assert.throws(() => parseArgs(['--key', 'synthetic-private-input']));
  assert.throws(() => safeOrigin('https://user:secret@example.invalid/'));
  assert.throws(() => safeOrigin('http://example.invalid/'));
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-credentials-'));
  try {
    const path = resolve(directory, 'key');
    writeFileSync(path, 'synthetic-private-input', { mode: 0o644 });
    await assert.rejects(privateFile(path));
    chmodSync(path, 0o600);
    assert.equal(await privateFile(path), 'synthetic-private-input');
    symlinkSync(path, resolve(directory, 'alias'));
    await assert.rejects(privateFile(resolve(directory, 'alias')));
    const result = spawnSync(
      process.execPath,
      ['tools/guided-acceptance.mjs', '--key', 'synthetic-private-input'],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-private-input'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI help performs no authentication and defaults do not authorize runs', () => {
  assert.equal(parseArgs(['--expected-revision', 'a'.repeat(40)]).run, false);
  const result = spawnSync(process.execPath, ['tools/guided-acceptance.mjs', '--help'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Default: read-only/);
  assert.equal(result.stderr, '');
});

test('versioned briefs match the canonical shared contract and fixed policy across all phases', () => {
  assert.equal(briefs.build, guidedBuildIntent);
  assert.equal(briefs.extend, guidedExtendIntent);
  assert.deepEqual(
    briefs.concurrent.map((item) => item.intent),
    [...guidedConcurrentIntents],
  );
  assert.deepEqual(
    briefs.concurrent.map((item) => item.variant),
    ['filter', 'sort'],
  );
  assert.ok(!/stable|assigned once|replac.*IDs/i.test(briefs.extend));
  const policy = guidedPolicy();
  assert.equal(policy.version, 'task-board-v1');
  assert.deepEqual(policy.required_checks, ['guided-task-board']);
  assert.deepEqual(policy.build.checks[0].argv, [
    'node',
    '/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs',
  ]);
  assert.deepEqual(policy.build.test_bundle.protected_paths, [
    'README.md',
    '.yoneda-guided',
    'fixtures/guided-task-board/oracle',
  ]);
  assert.equal(policy.build.test_bundle.digest, protectedBundle().digest);
  assert.equal(
    createHash('sha256').update(canonicalBundle(protectedBundle().files).encoded).digest('hex'),
    protectedBundle().digest,
  );
  assert.equal(policy.build.static_dir, 'public');
});

test('version 2 briefs are short plain prompts that keep only what the checks need', () => {
  const v2 = guidedBriefs(2);
  assert.equal(v2.version, 2);
  assert.equal(v2.build, guidedIntents(2).build);
  assert.equal(v2.extend, guidedIntents(2).extend);
  assert.deepEqual(
    v2.concurrent.map((item) => item.intent),
    [...guidedIntents(2).concurrent],
  );
  assert.deepEqual(
    v2.concurrent.map((item) => item.variant),
    ['filter', 'sort'],
  );
  assert.equal(guidedIntents(1).build, guidedBuildIntent);
  const prompts = [v2.build, v2.extend, ...v2.concurrent.map((item) => item.intent)];
  for (const prompt of prompts) {
    assert.ok(prompt.split(/(?<=\.)\s+/).length <= 4, prompt);
    assert.ok(!/contract|captured|coordinate|specialist|integrat/i.test(prompt), prompt);
  }
  for (const needed of [
    'addTask(tasks,title,id)',
    'completeTask(tasks,id)',
    'visibleTasks(tasks,options)',
    '{id,title,completed}',
    'case-insensitively',
    "keep each task's id stable",
  ])
    assert.ok(v2.build.includes(needed), needed);
  for (const needed of ['taskLink(task)', '#task=', 'resolveTaskLink(tasks,fragment)', 'or null'])
    assert.ok(v2.extend.includes(needed), needed);
  assert.ok(!/stable|assigned once|replac.*IDs/i.test(v2.extend));
  assert.match(v2.concurrent[0].intent, /options\.status set to all, active or completed/);
  assert.match(v2.concurrent[1].intent, /options\.sort set to title-asc or title-desc/);
});

test('version 1 keeps its published bundle while version 2 adds its own briefs over the same oracle', () => {
  assert.equal(
    protectedBundle(1).digest,
    'c7c3237e3ef948795dffefabc9596eacfcbb8a37761892f172741d6d145f16e7',
  );
  const v1 = protectedBundle(1).files;
  const v2 = protectedBundle(2).files;
  assert.ok(Object.hasOwn(v2, 'fixtures/guided-task-board/briefs/v2.json'));
  assert.ok(!Object.hasOwn(v2, 'fixtures/guided-task-board/briefs/v1.json'));
  for (const file of ['run.mjs', 'check.mjs', 'observe.mjs']) {
    const path = `fixtures/guided-task-board/oracle/${file}`;
    assert.deepEqual(v2[path], v1[path]);
  }
  assert.notEqual(protectedBundle(2).digest, protectedBundle(1).digest);
  assert.equal(guidedPolicy(2).build.test_bundle.digest, protectedBundle(2).digest);
  assert.throws(() => protectedBundle(3));
});
