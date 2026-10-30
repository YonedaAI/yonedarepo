// Public and private repositories live gate (item 31) for the staging kit: the kit account
// creates a public repository; stock Git clones it with no credentials at all (no helper, no
// header, no prompt), its API and web page answer without a session, and /explore lists it.
// Made private, an anonymous read and an anonymous fetch are refused (404 and 401) within
// the 1 s access bound of the change's answer, and /explore drops it. The repository is
// deleted at the end.
//
// Usage: node tools/staging-realworld.mjs --visibility [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64, Session, sleep } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
/** The platform's access bound (repo-head.ts ACCESS_MS), and the slack for the round trips. */
const ACCESS_MS = 1000;
const SLACK_MS = 500;

export async function visibilityFlow({ origin, api, platform }, metrics) {
  const name = `kit-visibility-${Date.now()}`;
  const text = '# Public\n';
  const repo = await platform.post('/repos', { name, visibility: 'public', policy: { required_checks: [], approvals: 0 }, files: [{ path: 'README.md', content_b64: b64(text) }], author });
  const path = `/repos/${repo.id}`;
  const anonymousApi = new Session(`${api}/api/v1`);
  const anonymousFront = new Session(origin);
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-visibility-'));
  // No credentials anywhere: an empty global config, no system config, no helper, no prompt.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const remote = `${api}/git/${repo.id}.git`;
  const git = (args) => {
    try {
      return { ok: true, out: execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stderr ?? e.message).slice(-400) };
    }
  };
  const listed = async () => (await anonymousApi.get('/explore?limit=100')).repos.some((r) => r.id === repo.id);
  try {
    // Public: stock Git, the API and the web page, all without credentials.
    const cloned = git(['clone', '-q', remote, 'public']);
    assert.ok(cloned.ok, `anonymous clone of a public repository: ${cloned.out}`);
    assert.equal(readFileSync(join(dir, 'public', 'README.md'), 'utf8'), text, 'the clone holds the file');
    const status = await anonymousApi.raw('GET', path);
    assert.equal(status.status, 200, `anonymous API read: ${JSON.stringify(status.body)}`);
    assert.deepEqual([status.body.visibility, status.body.viewer?.public], ['public', true]);
    const blob = await anonymousFront.raw('GET', `/api/v1${path}/blob?path=README.md`);
    assert.equal(blob.body.content, text, `anonymous read through the front origin: ${blob.status}`);
    const page = await fetch(`${origin}/source/${repo.id}`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    assert.equal(page.status, 301, 'an old repository address moves to its readable one');
    const readable = page.headers.get('location');
    assert.equal(new URL(readable, origin).pathname, status.body.path, 'the move names the readable path');
    const opened = await fetch(new URL(readable, origin), { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    assert.equal(opened.status, 200, 'the repository page loads without a session');
    assert.match(await opened.text(), /<div id="root"|<script/i, 'the page is the web app');
    assert.ok(await listed(), '/explore lists the public repository');
    const push = git(['-C', join(dir, 'public'), 'push', '-q', 'origin', 'HEAD:refs/heads/anon']);
    assert.ok(!push.ok, 'an anonymous push is refused');

    // Private: refused within the access bound of the change's answer.
    await platform.call('PUT', `${path}/visibility`, { visibility: 'private' });
    const answered = performance.now();
    const until = async (probe, what) => {
      for (;;) {
        const started = performance.now() - answered;
        if (await probe()) return Math.round(started);
        assert.ok(started < ACCESS_MS + SLACK_MS, `${what} still served ${Math.round(started)} ms after the change answered`);
        await sleep(100);
      }
    };
    metrics.api_refused_ms = await until(async () => (await anonymousApi.raw('GET', `${path}/refs`)).status === 404, 'an anonymous API read');
    metrics.git_refused_ms = await until(async () => !git(['ls-remote', remote]).ok, 'an anonymous fetch');
    const refused = git(['clone', '-q', remote, 'private']);
    assert.ok(!refused.ok && /401|Authentication|could not read Username|terminal prompts disabled/i.test(refused.out), `an anonymous clone of a private repository: ${refused.out}`);
    assert.ok(!(await listed()), '/explore no longer lists it');
    assert.equal((await platform.raw('GET', path)).status, 200, 'the owner still reads it');
    metrics.repo = repo.id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
  }
}
