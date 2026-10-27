// The check sandbox's test-bundle install script, run by real Node as the sandbox runs it:
// files land read-only outside the checkout, the printed digest is the received bytes' SHA-256,
// a retry replaces the read-only tree, and unsafe paths are refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundleInstallScript } from '../../cloudflare/worker/sandbox-shell.ts';

const install = (root, encoded) =>
  execFileSync(process.execPath, ['-e', bundleInstallScript, root], { input: encoded, stdio: 'pipe' }).toString();
const mode = (path) => (statSync(path).mode & 0o777).toString(8);

test('installs the bundle read-only and prints its digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const root = join(dir, 'test-bundle');
  try {
    const encoded = JSON.stringify({
      'run.mjs': { content: 'console.log(1)\n', executable: true },
      'tests/a/b.bin': { content: Buffer.from([0, 1, 2]).toString('base64'), executable: false, encoding: 'base64' },
    });
    assert.equal(install(root, encoded), createHash('sha256').update(encoded).digest('hex'));
    assert.deepEqual([...readFileSync(join(root, 'tests/a/b.bin'))], [0, 1, 2]);
    assert.deepEqual([mode(join(root, 'run.mjs')), mode(join(root, 'tests/a/b.bin'))], ['555', '444']);
    assert.deepEqual([mode(root), mode(join(root, 'tests')), mode(join(root, 'tests/a'))], ['555', '555', '555']);
    // A retried install replaces the read-only tree.
    const next = JSON.stringify({ 'run.mjs': { content: 'console.log(2)\n', executable: true } });
    install(root, next);
    assert.equal(readFileSync(join(root, 'run.mjs'), 'utf8'), 'console.log(2)\n');
    assert.throws(() => statSync(join(root, 'tests')));
    for (const unsafe of ['../x', '/abs', 'a\\b', 'a:b', '.git/config', 'a//b'])
      assert.throws(() => install(join(dir, 'other'), JSON.stringify({ [unsafe]: { content: '', executable: false } })), unsafe);
  } finally {
    chmodSync(dir, 0o755);
    execFileSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});
