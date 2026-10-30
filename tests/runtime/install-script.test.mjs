// The public CLI installer (frontend/public/install.sh, served at /install.sh) against a
// local stand-in for the site's /downloads: it picks the target, checks the archive
// against SHA256SUMS before installing anything, and refuses what it cannot verify. Also
// the downloads route's key, type and cache rules (cloudflare/worker/downloads.ts).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cacheControl, contentType, downloadKey } from '../../cloudflare/worker/downloads.ts';

const script = new URL('../../frontend/public/install.sh', import.meta.url);
const VERSION = '0.3.1';
const work = mkdtempSync(join(tmpdir(), 'yoneda-install-'));
const files = new Map();
let base = '';
let server;

// A release with one archive per target; `bad` serves a linux-arm64 archive whose bytes
// differ from the ones SHA256SUMS names.
function release() {
  const sums = [];
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
    const dir = join(work, `build-${target}`);
    mkdirSync(dir, { recursive: true });
    for (const bin of ['yoneda', 'git-remote-yoneda']) {
      writeFileSync(join(dir, bin), `#!/bin/sh\necho ${bin} ${target}\n`);
      chmodSync(join(dir, bin), 0o755);
    }
    const name = `yoneda-${VERSION}-${target}.tar.gz`;
    execFileSync('tar', ['-czf', join(work, name), '-C', dir, 'yoneda', 'git-remote-yoneda']);
    const bytes = readFileSync(join(work, name));
    files.set(`/downloads/cli/${VERSION}/${name}`, bytes);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  files.set(`/downloads/cli/${VERSION}/SHA256SUMS`, Buffer.from(`${sums.join('\n')}\n`));
  files.set('/downloads/cli/LATEST', Buffer.from(`${VERSION}\n`));
}

before(async () => {
  release();
  server = createServer((req, res) => {
    const body = files.get(req.url);
    res.writeHead(body ? 200 : 404).end(body ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Asynchronous: the stand-in server answers from this same process.
function install(env) {
  const dir = mkdtempSync(join(work, 'bin-'));
  return new Promise((resolve) => {
    execFile(
      'sh',
      [script.pathname],
      { env: { PATH: process.env.PATH, HOME: work, YONEDA_DOWNLOAD_BASE: base, YONEDA_INSTALL_DIR: dir, ...env } },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr, dir }),
    );
  });
}

test('is valid POSIX sh with the site placeholder the Worker fills in', () => {
  execFileSync('sh', ['-n', script.pathname]);
  const text = readFileSync(script, 'utf8');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.equal(text.split('__YONEDA_SITE__').length, 2);
});

test('installs both programs for the target, at the latest version', async () => {
  for (const target of ['linux-x64', 'darwin-arm64']) {
    const run = await install({ YONEDA_TARGET: target });
    assert.equal(run.status, 0, run.stderr);
    for (const bin of ['yoneda', 'git-remote-yoneda']) {
      const out = execFileSync(join(run.dir, bin), { encoding: 'utf8' });
      assert.equal(out, `${bin} ${target}\n`);
    }
    assert.match(run.stdout, new RegExp(`Installed yoneda ${VERSION.replaceAll('.', '\\.')} \\(${target}\\)`));
  }
});

test('refuses an archive whose checksum does not match, installing nothing', async () => {
  const key = `/downloads/cli/${VERSION}/yoneda-${VERSION}-linux-arm64.tar.gz`;
  const good = files.get(key);
  files.set(key, Buffer.concat([good, Buffer.from('tampered')]));
  try {
    const run = await install({ YONEDA_TARGET: 'linux-arm64' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(run.dir, 'yoneda')), false);
  } finally {
    files.set(key, good);
  }
});

test('refuses an unknown target, a missing version and a malformed version', async () => {
  let run = await install({ YONEDA_TARGET: 'windows-x64' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no prebuilt yoneda/);
  run = await install({ YONEDA_TARGET: 'linux-x64', YONEDA_VERSION: '9.9.9' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /could not download/);
  run = await install({ YONEDA_TARGET: 'linux-x64', YONEDA_VERSION: '1.0;rm -rf /' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unexpected version/);
});

test('serves only release keys, with their types and cache rules', () => {
  assert.equal(downloadKey('/downloads/cli/LATEST'), 'cli/LATEST');
  assert.equal(downloadKey('/downloads/cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz'), 'cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz');
  assert.equal(downloadKey('/downloads/claude/marketplace.json'), 'claude/marketplace.json');
  for (const bad of ['/downloads/', '/downloads/other/x', '/downloads/cli/../x', '/downloads/cli/a/b/c', '/downloads/cli/%2e%2e', '/downloads/cli/.'])
    assert.equal(downloadKey(bad), undefined, bad);
  assert.equal(contentType('cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz'), 'application/gzip');
  assert.equal(contentType('claude/yoneda-0.2.0.zip'), 'application/zip');
  assert.equal(contentType('claude/marketplace.json'), 'application/json');
  assert.equal(contentType('cli/0.3.1/SHA256SUMS'), 'text/plain; charset=utf-8');
  assert.match(cacheControl('cli/LATEST'), /max-age=300/);
  assert.match(cacheControl('cli/latest.json'), /max-age=300/);
  assert.match(cacheControl('claude/marketplace.json'), /max-age=300/);
  assert.match(cacheControl('cli/0.3.1/SHA256SUMS'), /immutable/);
});
