import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collect } from '../../tools/platform-import.mjs';

test('collects regular files with modes and skips build output and links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-import-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'src', 'a.txt'), 'a\n');
  await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
  await chmod(join(root, 'run.sh'), 0o755);
  await writeFile(join(root, 'node_modules', 'x.js'), '');
  await symlink('src/a.txt', join(root, 'link'));
  const { files, skipped } = await collect(root);
  assert.deepEqual(files.map((f) => [f.path, f.executable ?? false]), [['run.sh', true], ['src/a.txt', false]]);
  assert.equal(Buffer.from(files[1].content_b64, 'base64').toString(), 'a\n');
  assert.deepEqual(skipped, ['link (not a regular file)']);
});
