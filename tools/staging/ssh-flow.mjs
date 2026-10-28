// Git over SSH (kit item 26, and the local end-to-end test tests/ssh/e2e.mjs) with stock git
// and OpenSSH, zero model spend. Fresh ed25519 keys in a temporary directory: one added to
// the account over REST, one never added. Checks: `ssh -T` greets the account; a client
// offering the unknown key first is still the known key's account; protocol v2 clone, a
// partial (blob:none) and a shallow clone; push of a branch and of main; a delete-only push;
// a version 0 fetch, a command other than Git's, an unknown repository and (with `other`)
// another account's key are refused; a key removed while a session is open stops that
// session's next request, and new connections. Keys never leave the temporary directory.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64 } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const pkt = (text) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

function keypair(dir, name) {
  const path = join(dir, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `kit-${name}`, '-f', path]);
  return { path, public: readFileSync(`${path}.pub`, 'utf8').trim() };
}

/** Collects a child's output until `done(text)` holds or it exits. */
function reader(stream) {
  let text = '';
  const waiters = [];
  stream.on('data', (chunk) => {
    text += chunk.toString('latin1');
    for (const w of [...waiters]) if (w.test(text)) waiters.splice(waiters.indexOf(w), 1), w.resolve(text);
  });
  return {
    get text() {
      return text;
    },
    until(test, ms = 30_000) {
      if (test(text)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const waiter = { test, resolve };
        waiters.push(waiter);
        setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(text.slice(-300))}`)), ms);
      });
    },
  };
}

export async function sshFlow({ platform, other, sshHost, sshPort = 22 }, metrics) {
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-ssh-'));
  const known = keypair(dir, 'known');
  const unknown = keypair(dir, 'unknown');
  const sshArgs = (...keys) => [
    '-F', '/dev/null', '-p', String(sshPort), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
    '-o', 'LogLevel=ERROR', ...keys.flatMap((k) => ['-i', k.path]),
  ];
  const env = (...keys) => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_SSH_COMMAND: ['ssh', ...sshArgs(...keys)].map((a) => `'${a}'`).join(' '),
  });
  writeFileSync(join(dir, 'gitconfig'), `[user]\n\tname = ${author.name}\n\temail = ${author.email}\n[protocol]\n\tversion = 2\n`);
  const run = (cmd, args, { cwd = dir, keys = [known] } = {}) => {
    const started = performance.now();
    try {
      const out = execFileSync(cmd, args, { cwd, env: env(...keys), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, out: out.trim(), ms: Math.round(performance.now() - started) };
    } catch (e) {
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? e.message}`.slice(-1500), status: e.status };
    }
  };
  const git = (args, options) => run('git', args, options);
  const must = (result, what) => {
    assert.ok(result.ok, `${what}: ${result.out}`);
    return result;
  };
  const refused = (result, what, pattern) => {
    assert.ok(!result.ok, `${what} should be refused: ${result.out}`);
    if (pattern) assert.match(result.out, pattern, what);
    return result.out.split('\n').find((l) => pattern?.test(l)) ?? result.out.slice(-200);
  };
  const keys = [];
  try {
    const name = `kit-ssh-${Date.now()}`;
    const files = [{ path: 'README.md', content_b64: b64('# ssh kit\n') }, { path: 'src/a.txt', content_b64: b64('a\n') }];
    const repo = await platform.post('/repos', { name, policy: { required_checks: [], approvals: 0 }, files, author });
    const added = await platform.post('/ssh-keys', { title: 'kit', key: known.public });
    keys.push(added.id);
    metrics.fingerprint = added.fingerprint;
    const url = `ssh://git@${sshHost}:${sshPort}/${repo.id}.git`;
    const ssh = (args, keyList = [known]) => run('ssh', [...sshArgs(...keyList), `git@${sshHost}`, ...args]);

    const hello = ssh(['-T']);
    assert.equal(hello.status, 1, hello.out);
    assert.match(hello.out, /Hi [\w.-]+! You've successfully authenticated/);
    metrics.greeting = hello.out.trim();
    // The unknown key is offered (and signs) first; the identity is still the known key's.
    const both = ssh(['-T'], [unknown, known]);
    assert.equal(both.out.trim(), hello.out.trim());
    refused(ssh(['-T'], [unknown]), 'an unknown key', /Permission denied/);

    metrics.clone_ms = must(git(['clone', '-q', url, 'full']), 'v2 clone').ms;
    assert.equal(readFileSync(join(dir, 'full/src/a.txt'), 'utf8'), 'a\n');
    metrics.partial_clone_ms = must(git(['clone', '-q', '--filter=blob:none', url, 'partial']), 'partial clone').ms;
    assert.equal(readFileSync(join(dir, 'partial/README.md'), 'utf8'), '# ssh kit\n');
    must(git(['clone', '-q', '--depth', '1', url, 'shallow']), 'shallow clone');
    assert.equal(must(git(['rev-list', '--count', 'HEAD'], { cwd: join(dir, 'shallow') }), 'count').out, '1');

    const work = join(dir, 'full');
    writeFileSync(join(work, 'src/b.txt'), 'pushed over ssh\n');
    must(git(['add', '.'], { cwd: work }), 'add');
    must(git(['commit', '-qm', 'ssh push'], { cwd: work }), 'commit');
    metrics.push_branch_ms = must(git(['push', '-q', 'origin', 'HEAD:refs/heads/ssh-topic'], { cwd: work }), 'push branch').ms;
    metrics.push_main_ms = must(git(['push', '-q', 'origin', 'HEAD:main'], { cwd: work }), 'push main').ms;
    const head = must(git(['rev-parse', 'HEAD'], { cwd: work }), 'rev-parse').out;
    assert.ok(must(git(['ls-remote', url, 'refs/heads/main']), 'ls-remote main').out.startsWith(head), 'main is the pushed commit');
    must(git(['push', '-q', 'origin', '--delete', 'ssh-topic'], { cwd: work }), 'delete-only push');
    const remote = must(git(['ls-remote', url]), 'ls-remote').out;
    assert.ok(!remote.includes('refs/heads/ssh-topic') && remote.includes('refs/heads/main'), remote);
    must(git(['fetch', '-q', 'origin'], { cwd: join(dir, 'partial') }), 'fetch into the partial clone');

    metrics.v0_refused = refused(git(['-c', 'protocol.version=0', 'ls-remote', url]), 'a version 0 fetch', /protocol\.version 2/);
    metrics.shell_refused = refused(ssh(['ls', '/']), 'a non-Git command', /only `git clone`/);
    const missing = `ssh://git@${sshHost}:${sshPort}/r${'0'.repeat(20)}.git`;
    metrics.unknown_repo_refused = refused(git(['ls-remote', missing]), 'an unknown repository', /ERROR/);
    if (other) {
      const theirs = keypair(dir, 'other');
      const added2 = await other.post('/ssh-keys', { title: 'kit-other', key: theirs.public });
      try {
        metrics.other_account_refused = refused(git(['ls-remote', url], { keys: [theirs] }), "another account's key", /ERROR/);
      } finally {
        await other.call('DELETE', `/ssh-keys/${added2.id}`);
      }
    }

    // Removal stops an open session: ls-refs answers, the key is removed, the next is refused.
    const session = spawn('ssh', [...sshArgs(known), '-o', 'SetEnv=GIT_PROTOCOL=version=2', `git@${sshHost}`, `git-upload-pack '${repo.id}.git'`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => session.on('exit', resolve));
    const out = reader(session.stdout);
    const err = reader(session.stderr);
    await out.until((t) => t.includes('version 2') && t.endsWith('0000'));
    const lsRefs = `${pkt('command=ls-refs\n')}0000`;
    const mark = out.text.length;
    session.stdin.write(lsRefs);
    await out.until((t) => t.length > mark && t.slice(mark).includes('refs/heads/main') && t.endsWith('0000'));
    const removedAt = performance.now();
    await platform.call('DELETE', `/ssh-keys/${keys.pop()}`);
    session.stdin.write(lsRefs);
    const status = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
    assert.equal(status, 128, `revoked session exit: ${status}; stderr ${err.text}`);
    assert.match(err.text, /ERROR/);
    metrics.revoked_session_ms = Math.round(performance.now() - removedAt);
    metrics.revoked_session = err.text.trim().split('\n').pop();
    refused(ssh(['-T']), 'the removed key', /Permission denied/);
    return metrics;
  } finally {
    for (const id of keys) await platform.call('DELETE', `/ssh-keys/${id}`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
