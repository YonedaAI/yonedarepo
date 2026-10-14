import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const script = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function generate(path, count = 32) {
  const result = spawnSync(process.execPath, [script, '--out', path, '--files', String(count)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const nested = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(nested)));
    else result.push(nested);
  }
  return result;
}

test('fixture has exactly five distinct requested files, one delta, preserved unread content, and incompressible bytes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-fixture-test-'));
  try {
    const fixture = generate(join(temp, 'fixture'));
    assert.equal(fixture.version, 1);
    assert.equal(fixture.file_count, 32);
    assert.equal((await files(fixture.repository)).length, 32);
    assert.equal(new Set(fixture.requested_paths).size, 5);
    assert.equal(fixture.changed_files.length, 1);
    assert.equal(fixture.changed_files[0].path, fixture.requested_paths[0]);
    assert.ok(!fixture.requested_paths.includes(fixture.sealed_unread.path));
    const unread = await readFile(join(fixture.repository, fixture.sealed_unread.path));
    assert.equal(hash(unread), fixture.sealed_unread.sha256);
    const before = await readFile(join(fixture.repository, fixture.changed_files[0].path));
    const after = await readFile(fixture.changed_files[0].content_file);
    assert.notEqual(hash(before), hash(after));
    const content = Buffer.concat(
      await Promise.all((await files(fixture.repository)).map((path) => readFile(path))),
    );
    assert.ok(
      gzipSync(content).length / content.length > 0.98,
      'base content must not create a compression-friendly fake win',
    );
    assert.equal(fixture.requested_bytes, 5 * 4096);
    assert.equal(fixture.base_bytes, 32 * 4096);
    assert.match(fixture.base.commit, /^[a-f0-9]{40}$/);
    assert.match(fixture.base.tree, /^[a-f0-9]{40}$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('same seed produces identical Git authority and contents in independent fixture directories', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-deterministic-test-'));
  try {
    const first = generate(join(temp, 'first'));
    const second = generate(join(temp, 'second'));
    assert.deepEqual(first.base, second.base);
    assert.deepEqual(first.requested_paths, second.requested_paths);
    assert.equal(first.sealed_unread.sha256, second.sealed_unread.sha256);
    const result = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: first.repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      Number(result.stdout),
      3,
      'full clone includes history that lazy source must not fetch',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('fixture refuses an existing destination rather than replacing user files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-no-overwrite-test-'));
  try {
    const result = spawnSync(process.execPath, [script, '--out', temp], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.deepEqual(await readdir(temp), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
