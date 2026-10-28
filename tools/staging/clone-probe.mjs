// Where clone, fetch, search and blame time goes on a live platform, for one repository the
// owner already has. Each Git operation runs with `x-yoneda-timing: 1`, so every
// upload-pack answer carries Server-Timing (the walk, before the pack) and ends with a
// `remote: yoneda-timing ...` line (entries, deltas, bytes read and sent, waits while the
// pack streamed); the wall time and the pack bytes the client received are measured here.
// Search and blame print their Server-Timing. Read only: a read-scoped repository token is
// minted for the run and deleted afterwards; it reaches Git through the environment only.
//
// Usage (credentials from the environment only):
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/clone-probe.mjs --repo <id> [--runs 3] [--ref main] [--query permission]
//     [--path README.md] [--only clone,partial,shallow,deepen,search,blame]
//     [--reference <public clone URL>] [--origin <front>] [--api <platform host>]
// `--reference` clones the same history from elsewhere (e.g. GitHub) as the client's
// bandwidth floor.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from './client.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    runs: { type: 'string', default: '1' },
    ref: { type: 'string', default: 'main' },
    query: { type: 'string', default: 'permission' },
    path: { type: 'string', default: 'README.md' },
    only: { type: 'string', default: 'clone,partial,shallow,deepen,search,blame' },
    reference: { type: 'string' },
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
  },
});
const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
assert.ok(username && password, 'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD');
assert.ok(values.repo, '--repo <repository id> is required');
const only = new Set(values.only.split(','));

const login = await new Session(values.origin).raw('POST', '/api/auth/login', { username, password });
assert.equal(login.status, 200, `owner sign-in failed: ${login.status}`);
const owner = new Session(`${values.origin}/api/v1`, { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] });
const name = `clone-probe-${Date.now()}`;
const { token } = await owner.post(`/repos/${values.repo}/tokens`, { name, scopes: ['read'] });
const dir = mkdtempSync(join(tmpdir(), 'yoneda-clone-probe-'));

const config = join(dir, 'gitconfig');
writeFileSync(config, '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
const env = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  GIT_CONFIG_KEY_1: 'http.extraHeader',
  GIT_CONFIG_VALUE_1: 'x-yoneda-timing: 1',
};
const scrub = (text) => String(text).split(token).join('<token>');

/** Runs Git (against the platform unless `elsewhere`, which never gets the token); answers
 * wall ms, the Server-Timing of each request and the remote timing lines. */
function git(args, cwd, label, elsewhere = false) {
  const trace = join(dir, `${label}.trace`);
  const started = performance.now();
  const run = spawnSync('git', args, {
    cwd,
    env: { ...(elsewhere ? { ...env, GIT_CONFIG_COUNT: '0' } : env), GIT_TRACE_CURL: trace, GIT_TRACE_CURL_NO_DATA: '1' },
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const ms = Math.round(performance.now() - started);
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${scrub(run.stderr).slice(-600)}`);
  const requests = [];
  for (const line of existsSync(trace) ? readFileSync(trace, 'utf8').split('\n') : []) {
    const sent = /=> Send header: (GET|POST) (\S+)/.exec(line);
    if (sent) requests.push({ request: `${sent[1]} ${sent[2].replace(/\?.*/, '')}`, timing: '' });
    const timing = /<= Recv header: server-timing: (.*)/i.exec(line);
    if (timing && requests.length) requests.at(-1).timing = timing[1].trim();
  }
  rmSync(trace, { force: true });
  const remote = run.stderr.split(/[\r\n]/).filter((l) => l.includes('yoneda-timing')).map((l) => l.trim());
  return { ms, requests, remote };
}

const packMiB = (repo) => {
  const packs = join(repo, '.git/objects/pack');
  const bytes = readdirSync(packs)
    .filter((f) => f.endsWith('.pack'))
    .reduce((n, f) => n + statSync(join(packs, f)).size, 0);
  return (bytes / 1048576).toFixed(1);
};

function report(op, run, { ms, requests, remote }, extra = '') {
  console.log(`\n## ${op} (run ${run}): ${ms} ms${extra}`);
  for (const r of requests) console.log(`  ${r.request}  ${r.timing}`);
  for (const line of remote) console.log(`  ${line}`);
}

const remoteUrl = `${values.api}/git/${values.repo}.git`;
const branch = ['-b', values.ref];
try {
  for (let run = 1; run <= Number(values.runs); run++) {
    const at = (what) => join(dir, `${what}-${run}`);
    if (only.has('clone')) {
      const r = git(['clone', '--progress', '--no-checkout', ...branch, remoteUrl, at('full')], dir, `full-${run}`);
      report('clone --no-checkout', run, r, `, pack ${packMiB(at('full'))} MiB`);
    }
    if (only.has('partial')) {
      const r = git(['clone', '--progress', '--filter=blob:none', ...branch, remoteUrl, at('partial')], dir, `partial-${run}`);
      report('clone --filter=blob:none (with checkout)', run, r);
    }
    if (only.has('shallow') || only.has('deepen')) {
      const r = git(['clone', '--progress', '--no-checkout', '--depth', '1', ...branch, remoteUrl, at('shallow')], dir, `shallow-${run}`);
      report('clone --depth 1', run, r, `, pack ${packMiB(at('shallow'))} MiB`);
      if (only.has('deepen'))
        report('fetch --deepen 50', run, git(['fetch', '--progress', '--deepen', '50'], at('shallow'), `deepen-${run}`));
    }
    if (values.reference && only.has('clone')) {
      const r = git(['clone', '--progress', '--no-checkout', values.reference, at('reference')], dir, `reference-${run}`, true);
      console.log(`\n## reference clone ${values.reference} (run ${run}): ${r.ms} ms, pack ${packMiB(at('reference'))} MiB`);
    }
    const api = new Session(`${values.api}/api/v1`, { bearer: token });
    const rest = async (op, path) => {
      const r = await api.raw('GET', `/repos/${values.repo}${path}`);
      const size = r.body?.results?.length ?? r.body?.lines?.length ?? r.body?.error?.code ?? '';
      console.log(`\n## ${op} (run ${run}): ${Math.round(r.ms)} ms, ${r.status} (${size})\n  ${r.headers.get('server-timing') ?? ''}`);
    };
    const query = encodeURIComponent(values.query);
    if (only.has('search')) await rest(`search "${values.query}"`, `/search?q=${query}&ref=${values.ref}`);
    if (only.has('blame')) await rest(`blame ${values.path}`, `/blame?path=${encodeURIComponent(values.path)}&ref=${values.ref}`);
    for (const what of ['full', 'partial', 'shallow', 'reference']) rmSync(at(what), { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  const done = await owner.raw('DELETE', `/repos/${values.repo}/tokens/${name}`);
  if (!done.ok) console.error(`Deleting token ${name} failed: ${done.status}; delete it by hand`);
}
