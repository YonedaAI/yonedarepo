// yoneda:: clones (lazy, the default, and full) next to the same smart-HTTP clone, locally: `wrangler dev` serves the
// platform Worker (tests/ssh/wrangler.jsonc), the history of a pure source repository (an
// open-source clone given by --source; never this codebase) is pushed over HTTPS, then each
// clone runs --runs times. For the yoneda:: clone it counts the platform requests by kind
// from wrangler's request log (POST /objects pages, GET /objects/<id> blob downloads) with
// their server time, and prints min/median/max. No network beyond localhost.
// Usage: node tests/objects/clone-bench.mjs --source <git dir> [--runs 3] [--cli-bin target/release]
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { sleep } from '../../tools/staging/client.mjs';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    runs: { type: 'string', default: '3' },
    'cli-bin': { type: 'string' },
    log: { type: 'string' },
  },
});
if (!values.source) throw new Error('--source <git dir> (an open-source clone, never this codebase)');
const root = fileURLToPath(new URL('../../', import.meta.url));
// Never this codebase: the source must not share this checkout's first commit.
const roots = (cwd) => execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd, encoding: 'utf8' }).trim().split('\n');
if (roots(resolve(values.source)).some((r) => roots(root).includes(r))) throw new Error('this codebase is never test data');
const config = join(root, 'tests/ssh/wrangler.jsonc');
const wrangler = join(root, 'node_modules/.bin/wrangler');
const bin = resolve(values['cli-bin'] ?? join(root, 'target/release'));
const runs = Number(values.runs);
const execFileAsync = promisify(execFile);

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
};

const dir = mkdtempSync(join(tmpdir(), 'yoneda-clone-bench-'));
let log = '';
let platform;
try {
  const port = await freePort();
  const state = join(dir, 'state');
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'yoneda-ssh-e2e-index', '--local', '-c', config, '--persist-to', state], { cwd: root, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  platform = spawn(wrangler, ['dev', '-c', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  platform.stdout.on('data', (c) => (log += c));
  platform.stderr.on('data', (c) => (log += c));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; !(await fetch(`${origin}/health`).then((r) => r.ok, () => false)); i++) {
    if (i > 300) throw new Error('wrangler dev did not come up');
    await sleep(300);
  }
  const name = `bench_${Date.now().toString(36)}`;
  const signup = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, email: `${name}@example.invalid`, password: 'local clone bench password' }) });
  const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0];
  const api = async (path, body) => {
    const r = await fetch(`${origin}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  const repo = (await api('/repos', { name: 'bench', policy: { required_checks: [], approvals: 0 } })).id;
  const { token } = await api(`/repos/${repo}/tokens`, { name: 'bench', scopes: ['read', 'write', 'land'] });
  const git = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` };
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: values.source, encoding: 'utf8' }).trim();
  const timed = (args, env) => {
    const started = performance.now();
    execFileSync('git', args, { env, stdio: 'ignore' });
    return Math.round(performance.now() - started);
  };
  const pushMs = timed(['-C', resolve(values.source), 'push', '-q', `${origin}/git/${repo}.git`, `${branch}:refs/heads/main`], git);
  const https = [];
  // A yoneda:: clone is lazy by default (commits and trees; blobs as checkout needs them);
  // `-c yoneda.lazy=false` makes it a full one.
  const modes = { lazy: [], full: [] };
  const requests = { lazy: [], full: [] };
  for (let run = 0; run < runs; run++) {
    https.push(timed(['clone', '-q', `${origin}/git/${repo}.git`, join(dir, `https-${run}`)], git));
    for (const mode of Object.keys(modes)) {
      // The helper talks to the platform through a counting proxy: every request it makes,
      // with its time and answer size, measured from the client's side.
      const seen = [];
      const proxy = createHttpServer(async (req, res) => {
        const started = performance.now();
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(k)));
        try {
          const upstream = await fetch(`${origin}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
          const body = Buffer.from(await upstream.arrayBuffer());
          const back = {};
          upstream.headers.forEach((v, k) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) back[k] = v;
          });
          res.writeHead(upstream.status, back);
          res.end(body);
          seen.push({ key: `${req.method} ${req.url.replace(/r[0-9a-f]{20}/, '<repo>').replace(/[0-9a-f]{40}/, '<id>').replace(/\?.*$/, '')}`, ms: performance.now() - started, bytes: body.length });
        } catch {
          res.writeHead(502).end();
        }
      });
      await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
      const via = `http://127.0.0.1:${proxy.address().port}`;
      const target = join(dir, `${mode}-${run}`);
      // Asynchronously: a synchronous clone would block the proxy in this process.
      const started = performance.now();
      const config = mode === 'full' ? ['-c', 'yoneda.lazy=false'] : [];
      await execFileAsync('git', ['clone', '-q', ...config, `yoneda::${via}/${repo}`, target], { env: { ...git, PATH: `${bin}:${process.env.PATH}`, YONEDA_TOKEN: token, XDG_CONFIG_HOME: join(dir, 'config') }, maxBuffer: 1 << 26 });
      modes[mode].push(Math.round(performance.now() - started));
      await new Promise((done) => proxy.close(done));
      const kinds = {};
      for (const { key, ms, bytes } of seen) {
        kinds[key] ??= { count: 0, ms: 0, mib: 0 };
        kinds[key].count++;
        kinds[key].ms += Math.round(ms);
        kinds[key].mib = Number((kinds[key].mib + bytes / 1048576).toFixed(1));
      }
      const pages = seen.filter((r) => r.key.endsWith('/objects'));
      // Small pages are the commit and tree walk's rounds; large ones carry blobs.
      const bucket = (lo, hi) => {
        const list = pages.filter((p) => p.bytes >= lo && p.bytes < hi);
        return { count: list.length, ms: Math.round(list.reduce((a, p) => a + p.ms, 0)), mib: Number((list.reduce((a, p) => a + p.bytes, 0) / 1048576).toFixed(1)) };
      };
      requests[mode].push({ kinds, pages_by_size: { under_64k: bucket(0, 65536), under_1m: bucket(65536, 1 << 20), over_1m: bucket(1 << 20, Infinity) } });
      const heads = [join(dir, `https-${run}`), target].map((d) => execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      if (heads[0] !== heads[1]) throw new Error(`the ${mode} clone is at ${heads[1]}, not ${heads[0]}`);
    }
  }
  const ratio = (list) => Number((stats(list).median / stats(https).median).toFixed(1));
  console.log(JSON.stringify({ source: values.source, push_ms: pushMs, https_ms: stats(https), lazy_ms: stats(modes.lazy), lazy_ratio: ratio(modes.lazy), full_ms: stats(modes.full), full_ratio: ratio(modes.full), requests }, null, 2));
} catch (e) {
  console.error(`FAILED: ${e.stack ?? e}\n--- wrangler (last 3000 bytes)\n${log.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (values.log) writeFileSync(values.log, log);
  platform?.kill('SIGTERM');
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
