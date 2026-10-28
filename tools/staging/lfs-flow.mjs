// Git LFS (kit item 25) with stock git and git-lfs (zero model spend): in a fresh repository
// `git lfs track '*.bin'`, commit a random file (--lfs-mb, default 200 MB) and push; the
// bytes go straight to R2 through presigned URLs and are verified by the platform. A fresh
// clone pulls the file and its sha256 matches; the repository's LFS usage shows it; a
// read-only token's upload batch is refused (403). The token reaches Git only through the
// environment, as an extra header scoped to the API host (never sent to R2), never an
// argument. Needs git-lfs installed (`brew install git-lfs`).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64 } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const MB = 1024 * 1024;

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Writes `mb` MiB of random bytes to `path`, a MiB at a time. */
function randomFile(path, mb) {
  const fd = openSync(path, 'w');
  try {
    for (let i = 0; i < mb; i++) writeSync(fd, randomBytes(MB));
  } finally {
    closeSync(fd);
  }
}

export function gitLfsVersion() {
  try {
    return execFileSync('git', ['lfs', 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('git-lfs is not installed (brew install git-lfs); kit item 25 needs it');
  }
}

export async function lfsFlow({ api, platform, mb = 200 }, metrics) {
  metrics.git_lfs = gitLfsVersion();
  const name = `kit-lfs-${Date.now()}`;
  const files = [{ path: 'README.md', content_b64: b64('# lfs kit\n') }];
  const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author });
  const path = `/repos/${repo.id}`;
  const minted = await platform.post(`${path}/tokens`, { name: 'kit-git', scopes: ['read', 'write', 'land'] });
  const reader = await platform.post(`${path}/tokens`, { name: 'kit-read', scopes: ['read'] });
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-lfs-'));
  const remote = `${api}/git/${repo.id}.git`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_COUNT: '1',
    // Scoped to the API: presigned R2 URLs must not receive the token.
    GIT_CONFIG_KEY_0: `http.${api}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.token}`,
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Staging kit\n\temail = kit@yonedarepo.invalid\n');
  const git = (args, cwd = dir) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * MB }).trim() };
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message}`.slice(-1200) };
    }
  };
  const must = (args, what, cwd) => {
    const result = git(args, cwd);
    assert.ok(result.ok, `${what}: ${result.out}`);
    return result.out;
  };
  try {
    must(['lfs', 'install'], 'git lfs install');
    must(['clone', '-q', remote, 'work'], 'clone');
    const work = join(dir, 'work');
    must(['lfs', 'track', '*.bin'], "git lfs track '*.bin'", work);
    const big = join(work, 'big.bin');
    randomFile(big, mb);
    const size = statSync(big).size;
    const sha256 = await sha256File(big);
    must(['add', '.gitattributes', 'big.bin'], 'add', work);
    must(['commit', '-q', '-m', `LFS: ${mb} MiB of random bytes`], 'commit', work);
    assert.equal(must(['lfs', 'ls-files', '--long'], 'lfs ls-files', work).split(' ')[0], sha256, 'big.bin is an LFS pointer');
    let started = performance.now();
    must(['push', '-q', 'origin', 'HEAD:main'], 'push', work);
    metrics.push_ms = Math.round(performance.now() - started);
    metrics.push_mb_s = Math.round((size / MB / (metrics.push_ms / 1000)) * 10) / 10;

    const usage = await platform.get(`${path}/lfs`);
    assert.equal(usage.stored_bytes, size, 'the platform stores the file');
    assert.equal(usage.objects, 1);

    started = performance.now();
    must(['clone', '-q', remote, 'fresh'], 'fresh clone');
    metrics.clone_ms = Math.round(performance.now() - started);
    const pulled = join(dir, 'fresh', 'big.bin');
    assert.equal(statSync(pulled).size, size, 'the fresh clone has the whole file, not a pointer');
    assert.equal(await sha256File(pulled), sha256, 'the fresh clone matches the sha256');

    // A read-only token cannot upload: the batch API refuses it.
    const refused = await fetch(`${remote}/info/lfs/objects/batch`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`git:${reader.token}`).toString('base64')}`,
        accept: 'application/vnd.git-lfs+json',
        'content-type': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid: createHash('sha256').update('x').digest('hex'), size: 1 }] }),
    });
    assert.equal(refused.status, 403, 'a read-only token cannot upload');
    Object.assign(metrics, { repo: repo.id, mb, bytes: size, sha256: sha256.slice(0, 16) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
  }
}
