// Kit item 30 (`--realuser`), the Git half: the private workspace every Git and CLI process of
// the run uses, then the owner's repository cloned every way a person clones it (smart HTTP
// full, partial with a lazy checkout, shallow then deepened, the yoneda:: remote helper, SSH
// through the platform's ssh_config with a throwaway key) and everyday Git on scratch branches
// (branch, commit, push, pull --rebase over a server-side commit, cherry-pick, revert, an
// opt-in annotated tag, branch delete). Tokens reach Git and the CLI only through the
// environment; every write goes to a `realuser/<ts>-*` branch (realuser-plan.mjs `scratch`).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scratch, scratchRefs, timedSteps } from './realuser-plan.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
/** GET /refs is a snapshot up to 2 x REFS_MS (2 s) old for a reader in another isolate
 * (repo-snapshots.ts): a ref this run just moved is polled for up to that bound. */
export const REFS_BOUND_MS = 2500;

/** `refname`'s commit on the platform once it is `expected` (undefined: absent), polling
 * within `REFS_BOUND_MS`; else whatever it last read. `seen.lag_ms` keeps the longest wait. */
export async function settledRef(owner, repo, refname, expected, seen = {}) {
  const started = performance.now();
  for (;;) {
    const value = (await owner.get(`/repos/${repo}/refs`)).refs[refname];
    const waited = Math.round(performance.now() - started);
    if (value === expected || waited > REFS_BOUND_MS) {
      if (value === expected) seen.lag_ms = Math.max(seen.lag_ms ?? 0, waited);
      return value;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const AUTHOR = { name: 'Real-user kit', email: 'realuser@yonedarepo.invalid' };

/** A 0700 temporary directory with its own Git config; processes get a token only per call. */
export class Workspace {
  constructor({ api, bin, scrub }) {
    this.api = api.replace(/\/$/, '');
    this.bin = bin;
    this.scrub = scrub;
    this.dir = mkdtempSync(join(tmpdir(), 'yoneda-realuser-'));
    chmodSync(this.dir, 0o700);
    this.gitConfig = join(this.dir, 'gitconfig');
    // No background maintenance: it races `git fsck` and the timings.
    writeFileSync(this.gitConfig, `[user]\n\tname = ${AUTHOR.name}\n\temail = ${AUTHOR.email}\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n`);
  }
  path = (...parts) => join(this.dir, ...parts);
  /** Smart HTTP with `token` as a header for the platform host, and the CLI's YONEDA_TOKEN. */
  env(token, extra = {}) {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: this.path('config'),
      GIT_CONFIG_GLOBAL: this.gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      YONEDA_ORIGIN: this.api,
      ...(token
        ? { YONEDA_TOKEN: token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${this.api}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` }
        : {}),
      ...extra,
    };
  }
  /** `{ code, stdout, stderr, ms }`, scrubbed; never throws on exit status. */
  run(command, args, { cwd = this.dir, token, extra } = {}) {
    const started = performance.now();
    return new Promise((done, reject) => {
      const child = spawn(command, args, { cwd, env: this.env(token, extra), stdio: ['ignore', 'pipe', 'pipe'] });
      let [stdout, stderr] = ['', ''];
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => done({ code, stdout: this.scrub(stdout).trim(), stderr: this.scrub(stderr).trim(), ms: Math.round(performance.now() - started) }));
    });
  }
  async ok(command, args, options) {
    const r = await this.run(command, args, options);
    assert.equal(r.code, 0, `${command} ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).slice(-500)}`);
    return r;
  }
  git = (cwd, token, ...args) => this.ok('git', args, { cwd, token }).then((r) => r.stdout);
  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Bytes of a clone's packs and loose objects (`git count-objects -v`, KiB). */
async function objectBytes(ws, dir) {
  const out = await ws.git(dir, null, 'count-objects', '-v');
  const kib = (key) => Number(out.match(new RegExp(`^${key}: (\\d+)`, 'm'))?.[1] ?? 0);
  return (kib('size-pack') + kib('size')) * 1024;
}

/** 30.1: every clone of the owner's repository; `ctx.mint(step)` is a read token for it. */
export async function realuserClones(ctx, metrics) {
  const { ws, repo, mint, owner, platformHealth } = ctx;
  const token = await mint('clone', ['read']);
  const url = `${ws.api}/git/${repo}.git`;
  const clone = async (key, args, dir, options = {}) => {
    const done = await ws.ok('git', ['clone', '-q', ...args, dir], { token, ...options });
    metrics[`${key}_ms`] = done.ms;
    return dir;
  };
  await timedSteps(
    metrics,
    [
      ['https full clone + fsck', async () => {
        const dir = await clone('full', [url], ws.path('full'));
        metrics.full_bytes = await objectBytes(ws, dir);
        metrics.commits = Number(await ws.git(dir, null, 'rev-list', '--count', 'HEAD'));
        metrics.files = (await ws.git(dir, null, 'ls-files')).split('\n').length;
        await ws.git(dir, null, 'fsck', '--no-progress');
        ctx.full = dir;
      }],
      ['partial clone (blob:none) + checkout', async () => {
        const dir = await clone('partial', ['--filter=blob:none', '--no-checkout', url], ws.path('partial'));
        metrics.partial_bytes = await objectBytes(ws, dir);
        metrics.partial_checkout_ms = (await ws.ok('git', ['checkout', '-q', 'main'], { cwd: dir, token })).ms;
        metrics.partial_after_checkout_bytes = await objectBytes(ws, dir);
        await ws.ok('git', ['fsck', '--no-progress'], { cwd: dir, token });
      }],
      ['shallow clone + deepen', async () => {
        const dir = await clone('shallow', ['--depth', '1', url], ws.path('shallow'));
        metrics.shallow_bytes = await objectBytes(ws, dir);
        metrics.deepen_ms = (await ws.ok('git', ['fetch', '-q', '--deepen', '50'], { cwd: dir, token })).ms;
        // Merges bring both parents, so 50 levels hold at least 51 commits (or all of them).
        metrics.deepened_commits = Number(await ws.git(dir, null, 'rev-list', '--count', 'HEAD'));
        assert.ok(metrics.deepened_commits >= Math.min(51, metrics.commits ?? 51), `deepened to ${metrics.deepened_commits} commits`);
        await ws.git(dir, null, 'fsck', '--no-progress');
      }],
      ['yoneda:: remote helper clone', async () => {
        if (!existsSync(join(ws.bin, 'git-remote-yoneda'))) return { skip: `no git-remote-yoneda in ${ws.bin} (cargo build -p yoneda-cli --release)` };
        const dir = await clone('helper', [`yoneda::${ws.api}/${repo}`], ws.path('helper'));
        metrics.helper_bytes = await objectBytes(ws, dir);
        assert.equal(await ws.git(dir, null, 'rev-parse', 'HEAD'), await ws.git(ctx.full ?? dir, null, 'rev-parse', 'origin/main'), 'the helper clone is main');
        await ws.git(dir, null, 'fsck', '--no-progress');
      }],
      ['ssh clone (throwaway key)', () => sshClone({ ws, repo, owner, platformHealth }, metrics)],
    ],
    ws.scrub,
  );
}

async function sshClone({ ws, repo, owner, platformHealth }, metrics) {
  if (!platformHealth.ssh) return { skip: 'Git over SSH is off on this platform' };
  if (platformHealth.ssh === 'tunnel' && spawnSync('cloudflared', ['--version']).status !== 0) return { skip: 'cloudflared is not installed' };
  const key = ws.path('ssh-key');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'realuser', '-f', key]);
  const added = await owner.post('/ssh-keys', { title: `realuser-${Date.now()}`, key: readFileSync(`${key}.pub`, 'utf8').trim() });
  try {
    const config = added.ssh?.ssh_config ? ws.path('ssh_config') : '/dev/null';
    if (added.ssh?.ssh_config) writeFileSync(config, added.ssh.ssh_config);
    const host = added.ssh?.host;
    assert.ok(host, 'the platform named no SSH host');
    const ssh = ['ssh', '-F', config, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${ws.path('known_hosts')}`, '-o', 'LogLevel=ERROR', '-i', key];
    const done = await ws.ok('git', ['clone', '-q', `ssh://git@${host}:22/${repo}.git`, ws.path('ssh')], { extra: { GIT_SSH_COMMAND: ssh.map((a) => `'${a}'`).join(' ') } });
    metrics.ssh_ms = done.ms;
    metrics.ssh_bytes = await objectBytes(ws, ws.path('ssh'));
    metrics.ssh_via = added.ssh?.ssh_config ? 'platform ssh_config (cloudflared)' : host;
    await ws.git(ws.path('ssh'), null, 'fsck', '--no-progress');
  } finally {
    await owner.call('DELETE', `/ssh-keys/${added.id}`);
  }
}

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text, { flag: 'a' });
}

/** 30.2: everyday Git on scratch branches of the owner's repository. */
export async function realuserEveryday(ctx, metrics) {
  const { ws, repo, ts, owner, mint } = ctx;
  const token = await mint('git', ['read', 'write']);
  const refs = scratchRefs(ts);
  const url = `${ws.api}/git/${repo}.git`;
  const dir = ws.path('work');
  const git = (...args) => ws.git(dir, token, ...args);
  const remoteHead = (branch, expected) => settledRef(owner, repo, `refs/heads/${scratch(branch, ts)}`, expected, metrics);
  /** Pushes `local` to the scratch branch `branch` and requires the platform to hold it. */
  const push = async (local, branch, ...flags) => {
    const done = await ws.ok('git', ['push', '-q', ...flags, 'origin', `${local}:refs/heads/${scratch(branch, ts)}`], { cwd: dir, token });
    const sha = await git('rev-parse', local);
    assert.equal(await remoteHead(branch, sha), sha, `${branch} on the platform is not the pushed commit (after ${REFS_BOUND_MS} ms)`);
    return done.ms;
  };
  const commit = async (path, text, message) => {
    write(dir, path, text);
    await git('add', path);
    await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  let noted;
  await timedSteps(
    metrics,
    [
      ['partial clone for work', async () => {
        await ws.ok('git', ['clone', '-q', '--filter=blob:none', url, dir], { token });
      }],
      ['push scratch base', () => push('origin/main', refs.base)],
      ['branch, commit, push', async () => {
        await git('switch', '-q', '-c', refs.work, 'origin/main');
        noted = await commit('.realuser/notes.md', `realuser ${ts}: first line\n`, `realuser ${ts}: note`);
        metrics.push_ms = await push('HEAD', refs.work);
      }],
      ['pull --rebase over a server-side commit', async () => {
        const server = await owner.post(`/repos/${repo}/commits`, {
          ref: scratch(refs.work, ts),
          changes: [{ path: '.realuser/server.md', content_b64: b64(`server-side commit ${ts}\n`) }],
          message: `realuser ${ts}: server-side commit`,
          author: AUTHOR,
        });
        await owner.post(`/repos/${repo}/land`, { ref: scratch(refs.work, ts), commit: server.commit });
        await commit('.realuser/notes.md', 'second line\n', `realuser ${ts}: second note`);
        metrics.pull_rebase_ms = (await ws.ok('git', ['pull', '-q', '--rebase', 'origin', refs.work], { cwd: dir, token })).ms;
        await git('merge-base', '--is-ancestor', server.commit, 'HEAD');
        assert.equal(await git('rev-list', '--merges', '--count', `${server.commit}..HEAD`), '0', 'the rebase made a merge');
        assert.ok(existsSync(join(dir, '.realuser/server.md')), 'the server-side file is not in the clone');
        await push('HEAD', refs.work);
      }],
      ['cherry-pick onto another branch', async () => {
        await git('switch', '-q', '-c', refs.pick, 'origin/main');
        await git('cherry-pick', noted);
        await push('HEAD', refs.pick);
        assert.match(readFileSync(join(dir, '.realuser/notes.md'), 'utf8'), /first line/);
      }],
      ['revert and push', async () => {
        await git('switch', '-q', refs.work);
        await git('revert', '--no-edit', 'HEAD');
        await push('HEAD', refs.work);
        assert.ok(!readFileSync(join(dir, '.realuser/notes.md'), 'utf8').includes('second line'), 'the revert left the line');
      }],
      ['annotated tag (opt-in: tags are permanent)', async () => {
        if (!ctx.tag) return { skip: 'tags cannot be deleted on the platform; --realuser-tag pushes a permanent one' };
        await git('tag', '-a', scratch(refs.tag, ts), '-m', `realuser ${ts}`);
        await ws.ok('git', ['push', '-q', 'origin', `refs/tags/${refs.tag}`], { cwd: dir, token });
        const served = (await ws.ok('git', ['ls-remote', 'origin', `refs/tags/${refs.tag}`], { cwd: dir, token })).stdout;
        assert.ok(served.includes(await git('rev-parse', refs.tag)), 'the tag object is not served');
      }],
      ['delete a branch', async () => {
        await ws.ok('git', ['push', '-q', 'origin', '--delete', scratch(refs.pick, ts)], { cwd: dir, token });
        assert.equal(await remoteHead(refs.pick, undefined), undefined, `${refs.pick} is still there`);
      }],
    ],
    ws.scrub,
  );
}
