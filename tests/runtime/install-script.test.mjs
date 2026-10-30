// The public CLI installers (frontend/public/install.sh and install.ps1, served at those
// paths) against a local stand-in for the site's /downloads and cloudflared's releases: they
// pick the target, check the archive against SHA256SUMS before installing anything, refuse
// what they cannot verify, and treat a cloudflared that fails to arrive or to verify as a
// warning. Also the downloads route's key, type and cache rules (cloudflare/worker/downloads.ts).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cacheControl, contentType, downloadKey, serveInstallScript } from '../../cloudflare/worker/downloads.ts';

const script = new URL('../../frontend/public/install.sh', import.meta.url);
const powershell = new URL('../../frontend/public/install.ps1', import.meta.url);
const VERSION = '0.3.1';
const CF_VERSION = /^cloudflared_version=(\S+)$/m.exec(readFileSync(script, 'utf8'))?.[1];
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
    sums.push(`${sha256(bytes)}  ${name}`);
  }
  // Windows: one zip per target, the same programs with .exe.
  for (const target of ['windows-x64', 'windows-arm64']) {
    const dir = join(work, `build-${target}`);
    mkdirSync(dir, { recursive: true });
    for (const bin of ['yoneda.exe', 'git-remote-yoneda.exe']) writeFileSync(join(dir, bin), `${bin} ${target}\n`);
    const name = `yoneda-${VERSION}-${target}.zip`;
    execFileSync('zip', ['-q', '-j', join(work, name), join(dir, 'yoneda.exe'), join(dir, 'git-remote-yoneda.exe')]);
    const bytes = readFileSync(join(work, name));
    files.set(`/downloads/cli/${VERSION}/${name}`, bytes);
    sums.push(`${sha256(bytes)}  ${name}`);
  }
  files.set(`/downloads/cli/${VERSION}/SHA256SUMS`, Buffer.from(`${sums.join('\n')}\n`));
  files.set('/downloads/cli/LATEST', Buffer.from(`${VERSION}\n`));
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// A stand-in for cloudflared, which the real script's pins do not match: `pinned` rewrites a
// copy of the script so it pins these bytes, as it pins the real file.
const CLOUDFLARED = Buffer.from('#!/bin/sh\necho cloudflared stand-in\n');
const cloudflaredPath = (asset) => `/cf/${CF_VERSION}/${asset}`;
function cloudflaredTgz() {
  const dir = join(work, 'cf-build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cloudflared'), CLOUDFLARED);
  chmodSync(join(dir, 'cloudflared'), 0o755);
  execFileSync('tar', ['-czf', join(work, 'cf.tgz'), '-C', dir, 'cloudflared']);
  return readFileSync(join(work, 'cf.tgz'));
}

/** install.sh with cloudflared coming from the stand-in server, pinned to `bytes` by asset. */
function scriptCopy(bytes = {}) {
  let text = readFileSync(script, 'utf8').replace(/^cloudflared_base=.*$/m, `cloudflared_base=${base}/cf`);
  for (const [asset, content] of Object.entries(bytes))
    text = text.replace(new RegExp(`(cloudflared_asset=${asset}\\n\\s*cloudflared_sum=)[0-9a-f]{64}`), `$1${sha256(content)}`);
  const path = join(mkdtempSync(join(work, 'script-')), 'install.sh');
  writeFileSync(path, text);
  return path;
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
// PATH holds the system's tools and, by default, no cloudflared (this machine may have one).
function install(env, path = scriptCopy()) {
  const dir = mkdtempSync(join(work, 'bin-'));
  return new Promise((resolve) => {
    execFile(
      'sh',
      [path],
      { env: { PATH: pathWithout('cloudflared'), HOME: work, YONEDA_DOWNLOAD_BASE: base, YONEDA_INSTALL_DIR: dir, ...env } },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr, dir }),
    );
  });
}

function pathWithout(program) {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => !existsSync(join(dir, program)))
    .join(':');
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

test('installs the pinned cloudflared beside yoneda, binary or archive', async () => {
  const assets = { 'cloudflared-linux-amd64': CLOUDFLARED, 'cloudflared-darwin-arm64.tgz': cloudflaredTgz() };
  for (const [asset, bytes] of Object.entries(assets)) files.set(cloudflaredPath(asset), bytes);
  const path = scriptCopy(assets);
  for (const target of ['linux-x64', 'darwin-arm64']) {
    const run = await install({ YONEDA_TARGET: target }, path);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`Installed cloudflared ${CF_VERSION.replaceAll('.', '\\.')}`));
    assert.equal(execFileSync(join(run.dir, 'cloudflared'), { encoding: 'utf8' }), 'cloudflared stand-in\n');
    assert.deepEqual(readdirSync(run.dir).filter((f) => f.startsWith('.')), []);
  }
});

test('stops using a cloudflared whose checksum does not match, and yoneda still installs', async () => {
  files.set(cloudflaredPath('cloudflared-linux-amd64'), Buffer.from('#!/bin/sh\necho tampered\n'));
  const run = await install({ YONEDA_TARGET: 'linux-x64' }, scriptCopy({ 'cloudflared-linux-amd64': CLOUDFLARED }));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /cloudflared checksum mismatch/);
  assert.equal(existsSync(join(run.dir, 'cloudflared')), false);
  assert.equal(existsSync(join(run.dir, 'yoneda')), true);
});

test('a cloudflared that cannot be fetched warns and the install still succeeds', async () => {
  files.delete(cloudflaredPath('cloudflared-linux-arm64'));
  const run = await install({ YONEDA_TARGET: 'linux-arm64' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /could not download cloudflared/);
  assert.equal(existsSync(join(run.dir, 'cloudflared')), false);
  assert.equal(existsSync(join(run.dir, 'yoneda')), true);
  assert.match(run.stdout, /Next: yoneda login/);
});

test('a working cloudflared on PATH is left alone and nothing is fetched', async () => {
  const bin = mkdtempSync(join(work, 'path-'));
  writeFileSync(join(bin, 'cloudflared'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'cloudflared'), 0o755);
  const run = await install({ YONEDA_TARGET: 'linux-x64', PATH: `${bin}:${pathWithout('cloudflared')}` });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /cloudflared is already installed/);
  assert.equal(run.stderr, '');
  assert.equal(existsSync(join(run.dir, 'cloudflared')), false);
});

test('pins every cloudflared asset to a full SHA-256, the same version in both installers', () => {
  const sh = readFileSync(script, 'utf8');
  const ps = readFileSync(powershell, 'utf8');
  for (const asset of ['darwin-arm64.tgz', 'darwin-amd64.tgz', 'linux-amd64', 'linux-arm64'])
    assert.match(sh, new RegExp(`cloudflared_asset=cloudflared-${asset}\\n\\s*cloudflared_sum=[0-9a-f]{64}\\n`));
  assert.match(ps, /\$cloudflaredSum = '[0-9a-f]{64}'/);
  assert.equal(/\$cloudflaredVersion = '([^']+)'/.exec(ps)?.[1], CF_VERSION);
  assert.match(CF_VERSION, /^\d{4}\.\d+\.\d+$/);
});

test('sends Git Bash and MSYS to the PowerShell installer', async () => {
  const run = await install({ YONEDA_TARGET: 'MINGW64_NT-10.0-x86_64' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /install\.ps1 \| iex/);
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

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1']).status === 0;
const pwsh = { skip: hasPwsh ? false : 'pwsh is not installed' };

/** The real command, `irm <site>/install.ps1 | iex`, in a fresh PowerShell. On a machine that
 * is not Windows the registry step is skipped, so nothing of the person's changes. */
function installOnWindows(env, bytes) {
  let text = readFileSync(powershell, 'utf8').replace(/\$cloudflaredBase = '[^']*'/, `$cloudflaredBase = '${base}/cf'`);
  if (bytes) text = text.replace(/\$cloudflaredSum = '[0-9a-f]{64}'/, `$cloudflaredSum = '${sha256(bytes)}'`);
  files.set('/install.ps1', Buffer.from(text));
  const dir = join(mkdtempSync(join(work, 'bin-')), 'with space');
  return new Promise((resolve) => {
    execFile(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', `irm ${base}/install.ps1 | iex; 'still in the session'`],
      { env: { PATH: pathWithout('cloudflared'), HOME: work, YONEDA_DOWNLOAD_BASE: base, YONEDA_INSTALL_DIR: dir, ...env } },
      (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr, dir }),
    );
  });
}

test('install.ps1 is ASCII, parses, and carries one site placeholder', pwsh, () => {
  const text = readFileSync(powershell, 'utf8');
  assert.equal(text.split('__YONEDA_SITE__').length, 2);
  assert.match(text, /^[\x00-\x7f]*$/, 'Windows PowerShell reads a BOM-less script as ANSI');
  assert.doesNotMatch(text, /^\s*exit\b/m, 'exit would close the window under iex');
  const parse = `$e = $null; [void][Management.Automation.Language.Parser]::ParseFile('${powershell.pathname}', [ref]$null, [ref]$e); $e.Count`;
  assert.equal(execFileSync('pwsh', ['-NoProfile', '-Command', parse], { encoding: 'utf8' }).trim(), '0');
});

test('install.ps1 installs both programs and the pinned cloudflared', pwsh, async () => {
  files.set(cloudflaredPath('cloudflared-windows-amd64.exe'), CLOUDFLARED);
  for (const target of ['windows-x64', 'windows-arm64']) {
    const run = await installOnWindows({ YONEDA_TARGET: target }, CLOUDFLARED);
    assert.equal(run.status, 0, run.stderr);
    for (const bin of ['yoneda.exe', 'git-remote-yoneda.exe'])
      assert.equal(readFileSync(join(run.dir, bin), 'utf8'), `${bin} ${target}\n`);
    assert.deepEqual(readFileSync(join(run.dir, 'cloudflared.exe')), CLOUDFLARED);
    assert.deepEqual(readdirSync(run.dir).filter((f) => f.startsWith('.')), []);
    assert.match(run.stdout, new RegExp(`Installed yoneda ${VERSION.replaceAll('.', '\\.')} \\(${target}\\)`));
    assert.match(run.stdout, /Next: yoneda login/);
    assert.match(run.stdout, /still in the session/);
  }
});

test('install.ps1 replaces an installed copy on the next run', pwsh, async () => {
  files.set(cloudflaredPath('cloudflared-windows-amd64.exe'), CLOUDFLARED);
  const first = await installOnWindows({ YONEDA_TARGET: 'windows-x64' }, CLOUDFLARED);
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(first.dir, 'yoneda.exe'), 'an older build');
  const again = await installOnWindows({ YONEDA_TARGET: 'windows-x64', YONEDA_INSTALL_DIR: first.dir }, CLOUDFLARED);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(first.dir, 'yoneda.exe'), 'utf8'), 'yoneda.exe windows-x64\n');
});

test('install.ps1 stops using a cloudflared that fails its checksum or does not arrive', pwsh, async () => {
  files.set(cloudflaredPath('cloudflared-windows-amd64.exe'), Buffer.from('tampered'));
  const tampered = await installOnWindows({ YONEDA_TARGET: 'windows-x64' }, CLOUDFLARED);
  assert.equal(tampered.status, 0, tampered.stderr);
  assert.match(`${tampered.stdout}${tampered.stderr}`, /cloudflared checksum mismatch/);
  assert.equal(existsSync(join(tampered.dir, 'cloudflared.exe')), false);
  assert.equal(existsSync(join(tampered.dir, 'yoneda.exe')), true);

  files.delete(cloudflaredPath('cloudflared-windows-amd64.exe'));
  const missing = await installOnWindows({ YONEDA_TARGET: 'windows-x64' }, CLOUDFLARED);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(`${missing.stdout}${missing.stderr}`, /could not download cloudflared/);
  assert.equal(existsSync(join(missing.dir, 'yoneda.exe')), true);
});

test('install.ps1 refuses a bad archive, target and version, installing nothing', pwsh, async () => {
  const key = `/downloads/cli/${VERSION}/yoneda-${VERSION}-windows-arm64.zip`;
  const good = files.get(key);
  files.set(key, Buffer.concat([good, Buffer.from('tampered')]));
  try {
    const run = await installOnWindows({ YONEDA_TARGET: 'windows-arm64' });
    assert.match(run.stdout + run.stderr, /checksum mismatch/);
    assert.equal(existsSync(join(run.dir, 'yoneda.exe')), false);
  } finally {
    files.set(key, good);
  }
  let run = await installOnWindows({ YONEDA_TARGET: 'windows-x86' });
  assert.match(run.stdout + run.stderr, /no prebuilt yoneda/);
  run = await installOnWindows({ YONEDA_TARGET: 'windows-x64', YONEDA_VERSION: '1.0;calc' });
  assert.match(run.stdout + run.stderr, /unexpected version/);
  run = await installOnWindows({ YONEDA_TARGET: 'windows-x64', YONEDA_VERSION: '9.9.9' });
  assert.match(run.stdout + run.stderr, /could not download/);
});

test('serves each installer from its own asset with the site filled in', async () => {
  const env = { ASSETS: { fetch: async (url) => new Response(`site=__YONEDA_SITE__ at ${new URL(url).pathname}`) } };
  const site = 'https://dev.yonedarepo.com';
  const served = async (path, origin = site) => serveInstallScript(new Request(`${site}${path}`), env, origin);
  const sh = await served('/install.sh');
  assert.equal(await sh.text(), `site=${site} at /install.sh`);
  assert.equal(sh.headers.get('content-type'), 'text/x-shellscript; charset=utf-8');
  const ps = await served('/install.ps1');
  assert.equal(await ps.text(), `site=${site} at /install.ps1`);
  assert.equal(ps.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(ps.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await served('/install.ps1', null)).status, 404);
});

test('serves only release keys, with their types and cache rules', () => {
  assert.equal(downloadKey('/downloads/cli/LATEST'), 'cli/LATEST');
  assert.equal(downloadKey('/downloads/cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz'), 'cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz');
  assert.equal(downloadKey('/downloads/claude/marketplace.json'), 'claude/marketplace.json');
  for (const bad of ['/downloads/', '/downloads/other/x', '/downloads/cli/../x', '/downloads/cli/a/b/c', '/downloads/cli/%2e%2e', '/downloads/cli/.'])
    assert.equal(downloadKey(bad), undefined, bad);
  assert.equal(downloadKey('/downloads/cli/0.3.1/yoneda-0.3.1-windows-x64.zip'), 'cli/0.3.1/yoneda-0.3.1-windows-x64.zip');
  assert.equal(contentType('cli/0.3.1/yoneda-0.3.1-linux-x64.tar.gz'), 'application/gzip');
  assert.equal(contentType('cli/0.3.1/yoneda-0.3.1-windows-x64.zip'), 'application/zip');
  assert.equal(contentType('claude/yoneda-0.2.0.zip'), 'application/zip');
  assert.equal(contentType('claude/marketplace.json'), 'application/json');
  assert.equal(contentType('cli/0.3.1/SHA256SUMS'), 'text/plain; charset=utf-8');
  assert.match(cacheControl('cli/LATEST'), /max-age=300/);
  assert.match(cacheControl('cli/latest.json'), /max-age=300/);
  assert.match(cacheControl('claude/marketplace.json'), /max-age=300/);
  assert.match(cacheControl('cli/0.3.1/SHA256SUMS'), /immutable/);
});
