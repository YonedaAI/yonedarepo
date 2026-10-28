// Annotated tags and releases (kit item 23) with stock Git over smart HTTP (zero model
// spend): in a fresh repository `git tag -a v1 -m x && git push origin v1`; a fresh clone
// holds the very tag object (`git cat-file -t v1` = tag); a release with notes and one
// asset is published, a read-only token is refused, and the downloaded asset matches the
// sha256 of the uploaded bytes and the recorded one. The repository token reaches Git only
// through the environment (http.extraHeader), never an argument.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64 } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function releasesFlow({ origin, api, platform }, metrics) {
  const name = `kit-release-${Date.now()}`;
  const files = [{ path: 'README.md', content_b64: b64('# release kit\n') }];
  const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author });
  const path = `/repos/${repo.id}`;
  const minted = await platform.post(`${path}/tokens`, { name: 'kit-git', scopes: ['read', 'write', 'land'] });
  const reader = await platform.post(`${path}/tokens`, { name: 'kit-read', scopes: ['read'] });
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-release-'));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.token}`,
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Staging kit\n\temail = kit@yonedarepo.invalid\n');
  const git = (args, cwd = dir) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message}`.slice(-600) };
    }
  };
  /** An asset request with `token` (the reader) or the kit account's session. */
  const asset = (method, token, body) =>
    fetch(`${origin}/api/v1${path}/releases/v1/assets/kit-asset.bin`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : { cookie: platform.cookie }),
        ...(body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  try {
    const remote = `${api}/git/${repo.id}.git`;
    assert.ok(git(['clone', '-q', remote, 'work']).ok, 'clone');
    const work = join(dir, 'work');
    assert.ok(git(['tag', '-a', 'v1', '-m', 'x'], work).ok, 'git tag -a');
    const object = git(['rev-parse', 'v1'], work).out;
    const commit = git(['rev-parse', 'v1^{commit}'], work).out;
    const started = performance.now();
    const pushed = git(['push', 'origin', 'v1'], work);
    assert.ok(pushed.ok, `push v1: ${pushed.out}`);
    metrics.tag_push_ms = Math.round(performance.now() - started);
    const refs = await platform.get(`${path}/refs`);
    assert.equal(refs.refs['refs/tags/v1'], commit, 'the tag names its commit');
    assert.equal(refs.annotated?.['refs/tags/v1'], object, 'the tag object is kept');

    assert.ok(git(['clone', '-q', remote, 'fresh']).ok, 'fresh clone');
    const fresh = join(dir, 'fresh');
    assert.equal(git(['cat-file', '-t', 'v1'], fresh).out, 'tag', 'a fresh clone has the annotated tag');
    assert.equal(git(['rev-parse', 'v1'], fresh).out, object, 'the same tag object');
    assert.equal(git(['rev-parse', 'v1^{commit}'], fresh).out, commit, 'peeled to the same commit');

    const release = { tag: 'v1', title: 'Kit release', notes: 'Release notes from the staging kit.\nSecond line.' };
    const refused = await fetch(`${origin}/api/v1${path}/releases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(release),
    });
    assert.equal(refused.status, 403, 'a read-only token cannot publish');
    const created = await platform.post(`${path}/releases`, release);
    assert.equal(created.commit_id, commit);

    const bytes = randomBytes(256 * 1024);
    const uploaded = await asset('PUT', null, bytes);
    const recorded = await uploaded.json();
    assert.equal(uploaded.status, 200, `upload: ${JSON.stringify(recorded)}`);
    assert.equal(recorded.sha256, sha256(bytes), 'the recorded sha256 is the uploaded bytes');
    const download = await asset('GET', reader.token);
    assert.equal(download.status, 200, 'a reader downloads');
    const got = Buffer.from(await download.arrayBuffer());
    assert.equal(sha256(got), sha256(bytes), 'the download matches the upload');
    assert.equal(download.headers.get('x-yoneda-sha256'), sha256(bytes));
    const shown = await platform.get(`${path}/releases/v1`);
    assert.equal(shown.notes, release.notes);
    assert.equal(shown.annotated?.message, 'x\n');
    Object.assign(metrics, { repo: repo.id, tag: object.slice(0, 12), asset_bytes: bytes.length, sha256: sha256(bytes).slice(0, 16) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
  }
}
