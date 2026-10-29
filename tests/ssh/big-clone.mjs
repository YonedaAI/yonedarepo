// A large clone over SSH next to the same clone over smart HTTP (tests/ssh/e2e.mjs --big N):
// a generated pure repository (random, incompressible file content over a few hundred commits,
// about N MiB packed; never this codebase) is pushed over HTTPS, then cloned both ways; the
// SSH clone must finish, fsck clean, at the same head, in time comparable to HTTPS (at most
// 3x plus 15 s). The repository token reaches Git only through the environment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMMITS = 200;
const FILES_PER_COMMIT = 12;

/** Writes `mb` MiB of random base64 text over COMMITS commits into a fresh repository at `dir`. */
function generate(dir, mb, env) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  // Base64 of random bytes packs to about 3/4 of its size: size each file so the pack is ~mb.
  const size = Math.ceil(((mb * 1024 * 1024) / (COMMITS * FILES_PER_COMMIT)) * (4 / 3));
  for (let c = 0; c < COMMITS; c++) {
    for (let f = 0; f < FILES_PER_COMMIT; f++) {
      const path = join(dir, `d${f % 8}`, `file${(c * FILES_PER_COMMIT + f) % 600}.txt`);
      mkdirSync(join(dir, `d${f % 8}`), { recursive: true });
      writeFileSync(path, randomBytes(Math.ceil((size * 3) / 4)).toString('base64'));
    }
    git('add', '-A');
    git('commit', '-q', '-m', `generated ${c}`);
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
}

const timed = (run) => {
  const started = performance.now();
  run();
  return Math.round(performance.now() - started);
};

/** `platform`: an account session on `${origin}/api/v1`; `ssh`: how to reach the gateway. */
export async function bigClone({ origin, platform, sshPort, proxyOverride, mb }, metrics) {
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-ssh-big-'));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Big clone\n\temail = big@yonedarepo.invalid\n[protocol]\n\tversion = 2\n[gc]\n\tauto = 0\n');
  const keys = [];
  let repo;
  try {
    const src = join(dir, 'src');
    mkdirSync(src);
    const head = generate(src, mb, env);
    metrics.objects = Number(execFileSync('git', ['count-objects', '-v'], { cwd: src, env, encoding: 'utf8' }).match(/^count: (\d+)/m)?.[1] ?? 0);
    const name = `ssh-big-${Date.now()}`;
    repo = { ...(await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 } })), name };
    const minted = await platform.post(`/repos/${repo.id}/tokens`, { name: 'big', scopes: ['read', 'write', 'land'] });
    const http = {
      ...env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.token}`,
    };
    const url = `${origin}/git/${repo.id}.git`;
    metrics.push_ms = timed(() => execFileSync('git', ['push', '-q', url, 'main'], { cwd: src, env: http, stdio: 'ignore' }));
    metrics.https_clone_ms = timed(() => execFileSync('git', ['clone', '-q', url, join(dir, 'https')], { env: http, stdio: 'ignore' }));
    metrics.pack_mib = Number((execFileSync('du', ['-sk', join(dir, 'https/.git/objects/pack')], { encoding: 'utf8' }).split('\t')[0] / 1024).toFixed(1));

    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')]);
    const added = await platform.post('/ssh-keys', { title: 'big', key: readFileSync(join(dir, 'key.pub'), 'utf8').trim() });
    keys.push(added.id);
    let config = '/dev/null';
    let host = '127.0.0.1';
    let port = sshPort;
    if (added.ssh?.ssh_config && proxyOverride) {
      config = join(dir, 'ssh_config');
      writeFileSync(config, added.ssh.ssh_config.replace('cloudflared access ssh --hostname %h', proxyOverride));
      host = added.ssh.host;
      port = 22;
    }
    const ssh = ['ssh', '-F', config, '-p', String(port), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`, '-o', 'LogLevel=ERROR', '-i', join(dir, 'key')];
    const sshEnv = { ...env, GIT_SSH_COMMAND: ssh.map((a) => `'${a}'`).join(' ') };
    const target = join(dir, 'ssh');
    try {
      metrics.ssh_clone_ms = timed(() =>
        execFileSync('git', ['clone', '-q', `ssh://git@${host}:${port}/${repo.id}.git`, target], { env: sshEnv, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15 * 60_000 }),
      );
    } catch (e) {
      throw new Error(`SSH clone of ${metrics.pack_mib} MiB failed: ${String(e.stderr ?? e.message).slice(-500)}`);
    }
    execFileSync('git', ['fsck', '--no-progress'], { cwd: target, env, stdio: 'ignore' });
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, env, encoding: 'utf8' }).trim(), head, 'the SSH clone is not at the pushed head');
    const bound = 3 * metrics.https_clone_ms + 15_000;
    assert.ok(metrics.ssh_clone_ms <= bound, `SSH clone took ${metrics.ssh_clone_ms} ms, HTTPS ${metrics.https_clone_ms} ms (bound ${bound} ms)`);
  } finally {
    for (const id of keys) await platform.call('DELETE', `/ssh-keys/${id}`).catch(() => {});
    if (repo) await platform.raw('DELETE', `/repos/${repo.id}?confirm=${encodeURIComponent(repo.name ?? '')}`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
