// Declared reads (C1) and session records (B8) live gate for the staging kit, with stock Git
// over smart HTTP (zero model spend). In a fresh repository, clone B changes config.json and
// lands it; clone A, which relied on config.json while editing app.js, pushes with
// `-o yoneda.reads=config.json` and must be refused with "read conflict on config.json";
// its commit carries the read set. After `git pull` the same declaration lands. The pusher
// then records a session on the landed commit and reads it back; a summary holding a
// credential is refused without echoing it. The repository token reaches Git only through
// the environment (http.extraHeader), never an argument.
//
// Usage: node tools/staging-realworld.mjs --reads-sessions [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, b64 } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };

export async function readsSessionsFlow({ origin, api, platform }, metrics) {
  const name = `kit-reads-${Date.now()}`;
  const files = [
    { path: 'config.json', content_b64: b64('{"v":1}\n') },
    { path: 'app.js', content_b64: b64('a\n') },
  ];
  const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author });
  const path = `/repos/${repo.id}`;
  const minted = await platform.post(`${path}/tokens`, { name: 'kit-git', scopes: ['read', 'write', 'land'] });
  const pusher = new Session(`${origin}/api/v1`, { bearer: minted.token });
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-reads-'));
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
  const edit = (cwd, file, text, message) => {
    writeFileSync(join(cwd, file), text);
    assert.ok(git(['commit', '-qam', message], cwd).ok, `commit ${message}`);
    return git(['rev-parse', 'HEAD'], cwd).out;
  };
  try {
    const remote = `${api}/git/${repo.id}.git`;
    for (const clone of ['a', 'b']) assert.ok(git(['clone', '-q', remote, clone]).ok, `clone ${clone}`);
    const [a, b] = [join(dir, 'a'), join(dir, 'b')];
    const mine = edit(a, 'app.js', 'a2\n', 'app relies on config v1');
    edit(b, 'config.json', '{"v":2}\n', 'config v2');
    assert.ok(git(['push', '-q', 'origin', 'main'], b).ok, 'B lands first');

    const refused = git(['push', '-o', 'yoneda.reads=config.json', 'origin', 'main'], a);
    assert.ok(!refused.ok && refused.out.includes('read conflict on config.json'), `stale read refused: ${refused.out}`);
    assert.deepEqual((await platform.get(`${path}/commits/${mine}`)).read_set, ['config.json'], 'the read set is the commit');

    assert.ok(git(['pull', '-q', '--no-rebase', 'origin', 'main'], a).ok, 'pull');
    const merged = git(['rev-parse', 'HEAD'], a).out;
    const started = performance.now();
    const landed = git(['push', '-o', 'yoneda.reads=config.json', 'origin', 'main'], a);
    assert.ok(landed.ok, `after pull: ${landed.out}`);
    metrics.push_ms = Math.round(performance.now() - started);
    assert.equal((await platform.get(`${path}/refs`)).refs['refs/heads/main'], merged, 'main is the merge');

    const record = { cli: 'claude-code', model: 'kit', summary: 'Kept app.js on config v2 after a read conflict.' };
    const posted = await pusher.post(`${path}/commits/${merged}/sessions`, record);
    const fake = ['sk-ant-', 'api03-'].join('') + 'Ab1'.repeat(31);
    const leaked = await pusher.raw('POST', `${path}/commits/${merged}/sessions`, { ...record, summary: `used ${fake}` });
    assert.ok(leaked.status === 422 && !JSON.stringify(leaked.body).includes(fake), 'a credential in a summary is refused');
    const { sessions } = await platform.get(`${path}/commits/${merged}/sessions`);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].summary, record.summary);
    metrics.session = posted.session;
    metrics.repo = repo.id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await platform.raw('DELETE', `${path}?confirm=${encodeURIComponent(name)}`);
  }
}
