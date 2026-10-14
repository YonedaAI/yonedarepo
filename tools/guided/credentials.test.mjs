import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateFile, safeOrigin } from './credentials.mjs';
import { parseArgs } from '../guided-acceptance.mjs';
import { briefs, guidedPolicy, protectedBundle } from './profile.mjs';
import {
  guidedBuildIntent,
  guidedExtendIntent,
  guidedConcurrentIntents,
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
