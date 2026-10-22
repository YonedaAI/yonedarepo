// Plumbing for the CLI items of the staging kit (cli-flow.mjs): a private temporary
// workspace, the `yoneda` and `git` processes run with the kit's personal access token in
// the environment only, the device login driven end to end, and a local proxy that kills a
// push between its uploads and its final compare-and-swap.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session, until } from './client.mjs';

export const PAT_SCOPES = ['repo:read', 'repo:write', 'repo:land', 'repo:review', 'repo:admin'];

/** One kit run's CLI context: a 0700 temporary directory (isolated Git and CLI config). */
export class CliKit {
  constructor({ api, bin, platformAccount }) {
    this.api = api.replace(/\/$/, '');
    this.bin = bin;
    this.platformAccount = platformAccount;
    this.dir = mkdtempSync(join(tmpdir(), 'yoneda-kit-cli-'));
    chmodSync(this.dir, 0o700);
    this.gitConfig = join(this.dir, 'gitconfig');
    writeFileSync(
      this.gitConfig,
      '[user]\n\tname = Staging kit\n\temail = kit@yonedarepo.invalid\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[advice]\n\tdetachedHead = false\n',
    );
    this.token = null;
    this.patId = null;
    this.repos = [];
  }
  /** The environment of every CLI and Git process: the token travels here, never in args. */
  env(extra = {}) {
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(this.dir, 'config'),
      GIT_CONFIG_GLOBAL: this.gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      YONEDA_ORIGIN: this.api,
      ...(this.token ? { YONEDA_TOKEN: this.token } : {}),
      ...extra,
    };
  }
  /** A PAT session on the platform API's own host. */
  pat(token = this.token) {
    return new Session(`${this.api}/api/v1`, { bearer: token });
  }
  path(...parts) {
    return join(this.dir, ...parts);
  }
  /** Removes secrets from process output before it is recorded. */
  scrub(text) {
    return this.token ? text.split(this.token).join('[token]') : text;
  }
  /** Runs `command args` in `cwd`; never throws on exit status. */
  run(command, args, { cwd = this.dir, env = this.env(), detached = false, onSpawn } = {}) {
    const started = performance.now();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
      onSpawn?.(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code, signal) =>
        resolvePromise({ code, signal, stdout: this.scrub(stdout).trim(), stderr: this.scrub(stderr).trim(), ms: Math.round(performance.now() - started) }),
      );
    });
  }
  /** Runs and requires exit 0; returns the result. */
  async ok(command, args, options) {
    const result = await this.run(command, args, options);
    assert.equal(result.code, 0, `${command} ${args.join(' ')} exited ${result.code ?? result.signal}: ${result.stderr.slice(-400) || result.stdout.slice(-400)}`);
    return result;
  }
  git = (cwd, ...args) => this.run('git', args, { cwd });
  gitOk = async (cwd, ...args) => (await this.ok('git', args, { cwd })).stdout;
  yoneda = (args, options) => this.run(join(this.bin, 'yoneda'), args, options);
  yonedaOk = (args, options) => this.ok(join(this.bin, 'yoneda'), args, options);
  remote(repo, origin = this.api) {
    return `yoneda::${origin}/${repo}`;
  }
  /** Deletes the workspace (clones and any stored credential). */
  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * `yoneda login` against the platform, approved with the kit account's session through the
 * same `/device/approve` call the website's /device page makes. The CLI stores the token
 * in the workspace's 0600 credentials file; it is read into memory and the file deleted.
 */
export async function deviceLogin(kit, metrics) {
  const started = performance.now();
  const child = spawn(join(kit.bin, 'yoneda'), ['login', '--no-browser', '--origin', kit.api], {
    cwd: kit.dir,
    env: { ...kit.env(), YONEDA_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((r) => child.on('close', (code) => r(code)));
  try {
    const code = await until(() => out.match(/enter the code ([A-Z]{4}-[A-Z]{4})/)?.[1] ?? (child.exitCode !== null && 'EXITED'), {
      timeoutMs: 30_000,
      intervalMs: 200,
      what: 'the device code from yoneda login',
    });
    assert.notEqual(code, 'EXITED', `yoneda login exited early: ${err.slice(-300)}`);
    metrics.device_code_ms = Math.round(performance.now() - started);
    const approved = await kit.platformAccount.post('/device/approve', { user_code: code, scopes: PAT_SCOPES, repos: null, expires_days: 1 });
    assert.equal(approved.approved, true, 'Device approval was not recorded');
    const status = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 90_000))]);
    assert.equal(status, 0, `yoneda login did not finish: ${status} ${err.slice(-300)}`);
    metrics.login_ms = Math.round(performance.now() - started);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const file = kit.path('config', 'yoneda', 'credentials');
  assert.ok(existsSync(file), 'yoneda login stored no credentials');
  metrics.credentials_mode = (statSync(file).mode & 0o777).toString(8);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file, { force: true });
  assert.equal(metrics.credentials_mode, '600', 'Stored credentials are not mode 0600');
  assert.match(stored.token ?? '', /^ypat_[A-Za-z0-9_-]{43}$/, 'The stored token is not a ypat_ token');
  assert.equal(stored.origin, kit.api, 'The token was stored for another origin');
  kit.token = stored.token;
  // The device token's id, for revocation: the account's newest token from this client.
  const { tokens } = await kit.platformAccount.get('/tokens');
  const mine = tokens.filter((t) => t.name === 'yoneda-cli').sort((a, b) => b.created_at - a.created_at)[0];
  assert.ok(mine, 'The device login token is not listed under /tokens');
  kit.patId = mine.id;
  metrics.pat_scopes = mine.scopes?.join(',');
}

const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive']);

/**
 * A local HTTP proxy to the platform that forwards every request until the push's final
 * compare-and-swap (`/land`, `/branches` or `/refs/batch`), then calls `onCas` (which kills
 * the push) and drops that request unanswered, so the platform never sees it.
 */
export async function casKillingProxy(target, onCas) {
  const seen = { forwarded: [], intercepted: null };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, 'http://proxy').pathname;
    if (req.method === 'POST' && /\/(land|branches|refs\/batch)$/.test(path)) {
      seen.intercepted = `${req.method} ${path}`;
      await onCas();
      req.socket.destroy();
      return;
    }
    seen.forwarded.push(`${req.method} ${path}`);
    try {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, body, redirect: 'manual' });
      const out = Buffer.from(await upstream.arrayBuffer());
      const back = {};
      upstream.headers.forEach((v, k) => {
        if (!HOP.has(k) && k !== 'content-encoding') back[k] = v;
      });
      res.writeHead(upstream.status, back);
      res.end(out);
    } catch {
      res.writeHead(502).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** True while any process of group `pgid` is alive. */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
