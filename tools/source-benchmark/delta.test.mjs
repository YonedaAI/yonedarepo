import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture.mjs';

const script = fileURLToPath(new URL('./delta.mjs', import.meta.url));
test('one-file Git delta preserves unread blobs, exact ancestor, original checkout and original HEAD', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-delta-test-'));
  try {
    const fixture = await createFixture(join(temp, 'fixture'), { files: 32 });
    const result = spawnSync(
      process.execPath,
      [script, '--fixture', join(temp, 'fixture', 'fixture.json')],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.kind, 'local-git-delta-case');
    assert.equal(captured.changed_bytes, 4096);
    assert.deepEqual(captured.object_closure.counts, { blob: 1, tree: 3, commit: 1 });
    assert.equal(captured.object_closure.blob_bytes, 4096);
    assert.ok(captured.object_closure.ancestor_metadata_bytes > 0);
    assert.ok(captured.object_closure.pack_bytes > 4096);
    assert.ok(captured.object_closure.pack_bytes < 20000);
    assert.equal(captured.parent, fixture.base.commit);
    const run = (args) => spawnSync('git', args, { cwd: fixture.repository, encoding: 'utf8' });
    assert.equal(run(['rev-parse', 'HEAD']).stdout.trim(), fixture.base.commit);
    assert.equal(run(['rev-parse', `${captured.commit}^`]).stdout.trim(), fixture.base.commit);
    assert.deepEqual(
      run(['diff-tree', '--no-commit-id', '--name-only', '-r', captured.commit])
        .stdout.trim()
        .split('\n'),
      [fixture.changed_files[0].path],
    );
    const unread = spawnSync('git', ['show', `${captured.commit}:${fixture.sealed_unread.path}`], {
      cwd: fixture.repository,
    });
    assert.equal(unread.status, 0);
    assert.equal(
      createHash('sha256').update(unread.stdout).digest('hex'),
      fixture.sealed_unread.sha256,
    );
    const original = await readFile(join(fixture.repository, fixture.changed_files[0].path));
    const updated = await readFile(fixture.changed_files[0].content_file);
    assert.notDeepEqual(original, updated);
    const delta = spawnSync(
      'git',
      ['show', `${captured.commit}:${fixture.changed_files[0].path}`],
      { cwd: fixture.repository },
    );
    assert.deepEqual(delta.stdout, updated);
    assert.ok(captured.capture_ms > 0);
    assert.equal(captured.source_api, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
