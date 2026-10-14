import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture.mjs';

const script = fileURLToPath(new URL('./baseline.mjs', import.meta.url));
test('full clone baseline measures actual local Git objects, all checkout bytes and retained history', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-baseline-test-'));
  try {
    const fixture = await createFixture(join(temp, 'fixture'), { files: 32 });
    const destination = join(temp, 'clone');
    const result = spawnSync(
      process.execPath,
      [script, '--fixture', join(temp, 'fixture', 'fixture.json'), '--out', destination],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout);
    assert.equal(measured.kind, 'local-full-git-clone');
    assert.equal(measured.commit, fixture.base.commit);
    assert.equal(measured.checkout_files, 32);
    assert.equal(measured.checkout_bytes, 32 * 4096);
    assert.equal(measured.history_commits, 3);
    assert.ok(measured.packed_git_object_bytes > measured.checkout_bytes);
    assert.ok(measured.clone_ms > 0);
    assert.ok(measured.requested_blob_bytes < measured.checkout_bytes);
    assert.equal(measured.requested_blob_bytes, 20480);
    const unread = await readFile(join(destination, fixture.sealed_unread.path));
    assert.equal(unread.length, 4096);
    assert.equal(
      measured.source_api,
      undefined,
      'a full clone is not evidence of SourceWorkspace readiness',
    );
    assert.equal(measured.fuse, undefined, 'a local Git checkout is not a Linux mount measurement');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('baseline rejects an existing output and leaves its contents untouched', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-baseline-no-overwrite-'));
  try {
    await createFixture(join(temp, 'fixture'), { files: 6 });
    const result = spawnSync(
      process.execPath,
      [script, '--fixture', join(temp, 'fixture', 'fixture.json'), '--out', temp],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.ok((await readFile(join(temp, 'fixture', 'fixture.json'))).length > 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
