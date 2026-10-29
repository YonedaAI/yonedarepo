// Size ladder: what repository sizes the platform really handles, from pure open-source
// imports (size-ladder.json: three rungs of about 100 MB, 1 GB and 5 GB of packed history,
// pinned commits, permissive licenses). Per rung, each run: an import (stock `git push` of
// the pinned commit's first-parent history in pushes within the receive limits), then a full
// clone against a reference clone of the same source, partial and shallow clones, search,
// blame, path history and the Overview, each with its wall time, Server-Timing, the fetch's
// `yoneda-timing` line (reads, read, wanted, read_wait, ...) and the timed DO and R2 calls
// (lower bounds: only timed phases are seen; peak memory is not exposed). Results are min /
// median / max over the runs, as JSON and a markdown table.
//
// Resumable: every finished step is written to the state file at once; a rerun skips what
// passed (failed steps are retried), and an import resumes after the last push main shows.
// Ladder repositories are kept (dev test repositories, AGENTS.md); `--cleanup` deletes them.
// Repository tokens are minted per invocation, reach Git through the environment only, and
// are deleted afterwards. `--plan-only` measures the sources and plans their pushes with no
// platform call at all.
//
// Limits it runs into (written before any live run):
// - push: 64 MiB of pack held, 40,000 objects, 100 MiB per file (planned at 40 MiB /
//   30,000; files over 8 MiB stream and must arrive whole: pushed with
//   core.bigFileThreshold=8m);
// - fetch: no object cap; at most 40,000 object-store reads (bundled history is read in
//   ranges) and 15 minutes;
// - Worker isolate 128 MB (a 64 MiB push is verified in memory); 50,000 subrequests;
// - repository DO SQLite 10 GB (bundle index rows, commit records and path changes grow
//   with objects and commits); stored clone packs (PACK_CACHE) in 5 MiB parts, 4 per repo.
// Request budget per op (server side): push = receive + one bundle put per batch + one
// index call per 5,000 objects + commit records; clone = access + walk + one locate per
// 2,000 ids + ranged bundle reads (or one GET of a stored pack); search = plan + one GET per
// segment (+ builds when cold); Overview = snapshot + one GET (warm); blame/history = one
// authority call + blob reads.
//
// Usage (credentials from the environment only):
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/size-ladder.mjs [--rungs svelte,kubernetes] [--runs 3]
//     [--only import,clone,reference,partial,shallow,search,blame,history,overview]
//     [--state .local/size-ladder/state.json] [--out .local/size-ladder] [--cleanup]
//     [--plan-only] [--timeout-min 120] [--origin <front>] [--api <platform host>]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from './client.mjs';
import * as lib from './size-ladder-lib.mjs';

const { values } = parseArgs({
  options: {
    ladder: { type: 'string', default: 'tools/staging/size-ladder.json' },
    rungs: { type: 'string' },
    runs: { type: 'string', default: '3' },
    only: { type: 'string', default: 'import,clone,reference,partial,shallow,search,blame,history,overview' },
    state: { type: 'string', default: '.local/size-ladder/state.json' },
    out: { type: 'string', default: '.local/size-ladder' },
    sources: { type: 'string', default: '.local/size-ladder/sources' },
    cleanup: { type: 'boolean', default: false },
    'plan-only': { type: 'boolean', default: false },
    'timeout-min': { type: 'string', default: '120' },
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
  },
});
const ladder = JSON.parse(readFileSync(values.ladder, 'utf8'));
const named = values.rungs?.split(',');
const rungs = ladder.rungs.filter((r) => (named ? named.includes(r.name) : !r.optional));
assert.ok(rungs.length, `no rung named ${values.rungs}`);
const runs = Number(values.runs);
const only = new Set(values.only.split(','));
const timeout = Number(values['timeout-min']) * 60_000;
const SHA = /^[0-9a-f]{40}$/;

const state = existsSync(values.state)
  ? JSON.parse(readFileSync(values.state, 'utf8'))
  : { rungs: {}, results: [] };
const save = () => {
  mkdirSync(dirname(values.state), { recursive: true });
  writeFileSync(`${values.state}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${values.state}.tmp`, values.state);
  const rows = lib.aggregate(state.results);
  mkdirSync(values.out, { recursive: true });
  const sources = Object.fromEntries(Object.entries(state.rungs).map(([n, r]) => [n, r.source]));
  writeFileSync(join(values.out, 'results.json'), JSON.stringify({ generated_at: new Date().toISOString(), sources, aggregate: rows }, null, 1));
  writeFileSync(join(values.out, 'results.md'), lib.markdownTable(rows, ladder));
};
const rungState = (rung) => (state.rungs[rung.name] ??= { imports: [] });

/** Runs a command; never throws (status, stdout, stderr, ms). */
function run(command, args, { cwd, env, input } = {}) {
  const started = performance.now();
  const r = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 1 << 30, timeout });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? ''), ms: Math.round(performance.now() - started) };
}
function ok(command, args, options) {
  const r = run(command, args, options);
  assert.equal(r.status, 0, `${command} ${args.join(' ')}: ${r.stderr.slice(-400)}`);
  return r.stdout.trim();
}

/** The rung's source as a bare clone (kept between runs and invocations) holding its commit. */
function source(rung) {
  assert.match(rung.commit, SHA);
  const dir = resolve(values.sources, `${rung.name}.git`);
  if (!existsSync(dir)) ok('git', ['clone', '-q', '--bare', '--single-branch', '--branch', rung.branch, rung.source, dir]);
  if (run('git', ['cat-file', '-e', `${rung.commit}^{commit}`], { cwd: dir }).status !== 0)
    ok('git', ['fetch', '-q', 'origin', `+refs/heads/${rung.branch}:refs/heads/${rung.branch}`], { cwd: dir });
  return dir;
}

/** Size, objects, commits and the largest blobs of the pinned commit, once per rung. */
function measure(rung, dir) {
  const rs = rungState(rung);
  if (rs.source) return rs.source;
  const count = Object.fromEntries(ok('git', ['count-objects', '-v'], { cwd: dir }).split('\n').map((l) => l.split(': ')));
  // Blobs: the largest size, then the ids of those over the push limit per object.
  const [largest, ...oversized] = ok('sh', ['-c', `git rev-list --objects ${rung.commit} | git cat-file --batch-check='%(objecttype) %(objectsize) %(objectname) %(rest)' | awk '$1=="blob"{ if ($2+0>m+0) m=$2; if ($2+0>${lib.PUSH_LIMITS.objectBytes}) o=o" "$3 } END {print m+0 o}'`], { cwd: dir }).split(' ');
  rs.source = {
    commit: rung.commit,
    pack_mib: Number(count['size-pack']) / 1024,
    objects: Number(ok('git', ['rev-list', '--objects', '--count', rung.commit], { cwd: dir })),
    commits: Number(ok('git', ['rev-list', '--count', rung.commit], { cwd: dir })),
    first_parent: Number(ok('git', ['rev-list', '--first-parent', '--count', rung.commit], { cwd: dir })),
    tip_entries: ok('git', ['ls-tree', '-r', '-t', rung.commit], { cwd: dir }).split('\n').length,
    largest_blob: Number(largest),
    blobs_over_push_limit: oversized,
  };
  save();
  return rs.source;
}

/** The pushes importing the rung (first-parent checkpoints within the push limits). */
async function plan(rung, dir) {
  const rs = rungState(rung);
  if (rs.checkpoints) return rs.checkpoints;
  const line = ok('git', ['rev-list', '--first-parent', '--reverse', rung.commit], { cwd: dir }).split('\n');
  const range = (from, to) => [line[to], ...(from >= 0 ? [`^${line[from]}`] : [])];
  const cost = async (from, to) => ({
    objects: Number(ok('git', ['rev-list', '--objects', '--count', ...range(from, to)], { cwd: dir })),
    bytes: Number(ok('git', ['rev-list', '--objects', '--disk-usage', ...range(from, to)], { cwd: dir })),
  });
  rs.checkpoints = (await lib.planCheckpoints(line.length, cost)).map((i) => line[i]);
  // The first push carrying a blob over the per-object limit (refused when pushed).
  const holds = (blob, at) => run('sh', ['-c', `git rev-list --objects ${at} | grep -q '^${blob}'`], { cwd: dir }).status === 0;
  const blobs = rs.source?.blobs_over_push_limit ?? [];
  const refused = rs.checkpoints.findIndex((c) => blobs.some((b) => /^[0-9a-f]{40}$/.test(b) && holds(b, c)));
  rs.refused_push = refused < 0 ? null : refused + 1;
  save();
  return rs.checkpoints;
}

// ---- platform ----
let owner;
const minted = [];
async function platform() {
  if (owner) return owner;
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(username && password, 'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD');
  const login = await new Session(values.origin).raw('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200, `owner sign-in failed: ${login.status}`);
  owner = new Session(`${values.origin}/api/v1`, { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] });
  return owner;
}
/** A token for `repo` for this invocation (deleted at the end). */
async function token(repo, scopes) {
  const name = `size-ladder-${Date.now()}-${minted.length}`;
  const { token: value } = await (await platform()).post(`/repos/${repo}/tokens`, { name, scopes });
  minted.push({ repo, name, value });
  return value;
}
const scrub = (text) => minted.reduce((t, m) => t.split(m.value).join('<token>'), String(text));
function gitEnv(secret, dir) {
  const config = join(dir, 'gitconfig');
  writeFileSync(config, '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TRACE_CURL: join(dir, 'trace'), GIT_TRACE_CURL_NO_DATA: '1',
    ...(secret ? { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`, GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: 'x-yoneda-timing: 1' } : {}) };
}

/** Git against the platform (or a reference remote with no secret) in a scratch directory:
 * the result with the requests' timings and the fetch timing line, as ladder metrics. */
function git(args, secret, cwd) {
  const scratch = mkdtempSync(join(tmpdir(), 'size-ladder-'));
  try {
    const r = run('git', args, { cwd: cwd ?? scratch, env: gitEnv(secret, scratch) });
    const trace = existsSync(join(scratch, 'trace')) ? readFileSync(join(scratch, 'trace'), 'utf8') : '';
    const phases = lib.mergePhases(lib.parseCurlTrace(trace).map((q) => lib.parseServerTiming(q.timing)));
    const line = r.stderr.split(/[\r\n]/).find((l) => l.includes('yoneda-timing'));
    const metrics = { ...lib.parseTimingLine(line), ...lib.requestCounts(phases) };
    for (const [k, v] of Object.entries(metrics)) if (typeof v !== 'number') delete metrics[k];
    const error = r.status === 0 ? undefined : scrub(r.stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 400);
    return { ok: r.status === 0, wall_ms: r.ms, error, metrics, server_timing: phases };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Import run `n` of `rung`: create (once), then push each checkpoint main is not past. */
async function importRun(rung, dir, n) {
  const rs = rungState(rung);
  const checkpoints = await plan(rung, dir);
  const name = `ladder-${rung.name}-${n}`;
  let entry = rs.imports.find((i) => i.run === n);
  if (!entry) {
    const created = await (await platform()).post('/repos', { name, policy: { required_checks: [], approvals: 0 } });
    entry = { run: n, id: created.id, name, pushes: [] };
    rs.imports.push(entry);
    save();
  }
  const secret = await token(entry.id, ['read', 'write', 'land']);
  const main = (await (await platform()).get(`/repos/${entry.id}/refs`)).refs['refs/heads/main'];
  const start = main ? checkpoints.indexOf(main) + 1 : 0;
  assert.ok(!main || start > 0, `${name}: main ${main} is no checkpoint of ${rung.commit}`);
  for (let k = start; k < checkpoints.length; k++) {
    // Files over 8 MiB go whole, never as deltas of other versions (the server streams them).
    const pushed = git(['-c', 'core.bigFileThreshold=8m', 'push', '-q', `${values.api}/git/${entry.id}.git`, `${checkpoints[k]}:refs/heads/main`], secret, dir);
    entry.pushes[k] = { ok: pushed.ok, wall_ms: pushed.wall_ms, error: pushed.error, metrics: pushed.metrics };
    save();
    if (!pushed.ok) break;
  }
  const pushes = entry.pushes.filter(Boolean);
  const landed = pushes.filter((p) => p.ok).length;
  const failed = pushes.find((p) => !p.ok);
  const sum = (k) => pushes.reduce((t, p) => t + (p.metrics?.[k] ?? 0), 0);
  return {
    ok: !failed && landed === checkpoints.length,
    wall_ms: pushes.reduce((t, p) => t + p.wall_ms, 0),
    error: failed && `push ${pushes.indexOf(failed) + 1}/${checkpoints.length}: ${failed.error}`,
    metrics: { pushes: landed, planned_pushes: checkpoints.length, do_calls: sum('do_calls'), r2_reads: sum('r2_reads') },
  };
}

const packMiB = (repo) => {
  const packs = join(repo, existsSync(join(repo, '.git')) ? '.git/objects/pack' : 'objects/pack');
  if (!existsSync(packs)) return null;
  return readdirSync(packs).filter((f) => f.endsWith('.pack')).reduce((n, f) => n + statSync(join(packs, f)).size, 0) / 1048576;
};
/** A clone into a scratch directory, with its pack size. */
function clone(args, url, secret) {
  const into = mkdtempSync(join(tmpdir(), 'size-ladder-clone-'));
  try {
    const r = git(['clone', '--progress', ...args, url, join(into, 'c')], secret);
    if (r.ok) r.metrics.pack_mib = packMiB(join(into, 'c'));
    return r;
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
}
/** A platform API read with its Server-Timing as metrics. */
async function api(path, secret) {
  const started = performance.now();
  const r = await new Session(`${values.api}/api/v1`, { bearer: secret }).raw('GET', path);
  const phases = lib.parseServerTiming(r.headers.get('server-timing'));
  const metrics = { ...lib.requestCounts(phases), server_total: phases.total?.ms };
  return { ok: r.ok, wall_ms: Math.round(performance.now() - started), error: r.ok ? undefined : `${r.status} ${r.body?.error?.code ?? ''} ${r.body?.error?.message ?? ''}`.slice(0, 400), metrics, server_timing: phases };
}

const reads = {
  clone: (rung, url, s) => clone(['--no-checkout', '-b', 'main'], url, s),
  reference: (rung) => clone(['--no-checkout', '--single-branch', '-b', rung.branch], rung.source),
  partial: (rung, url, s) => clone(['--filter=blob:none', '-b', 'main'], url, s),
  shallow: (rung, url, s) => clone(['--no-checkout', '--depth', '1', '-b', 'main'], url, s),
  search: (rung, url, s, id) => api(`/repos/${id}/search?q=${encodeURIComponent(rung.query)}&ref=main`, s),
  blame: (rung, url, s, id) => api(`/repos/${id}/blame?path=${encodeURIComponent(rung.path)}&ref=main`, s),
  history: (rung, url, s, id) => api(`/repos/${id}/log?ref=main&path=${encodeURIComponent(rung.path)}&limit=200`, s),
  overview: (rung, url, s, id) => api(`/repos/${id}/views/human?path=&ref=main`, s),
};

async function step(rung, op, n, work) {
  if (lib.done(state, rung.name, op, n)) return;
  let result;
  try {
    result = await work();
  } catch (e) {
    result = { ok: false, wall_ms: null, error: scrub(e?.message ?? e).slice(0, 400), metrics: {} };
  }
  lib.record(state, { rung: rung.name, op, run: n, at: new Date().toISOString(), ...result });
  save();
  console.log(`${rung.name} ${op} #${n}: ${result.ok ? 'ok' : 'FAILED'} ${result.wall_ms ?? '-'} ms${result.error ? ` (${result.error})` : ''}`);
}

try {
  for (const rung of rungs) {
    const dir = source(rung);
    console.log(`${rung.name}: ${JSON.stringify(measure(rung, dir))}`);
    if (values['plan-only']) {
      const planned = (await plan(rung, dir)).length;
      const refused = rungState(rung).refused_push;
      console.log(`${rung.name}: ${planned} pushes planned${refused ? `; push ${refused} carries a file over 100 MiB` : ''}`);
      continue;
    }
    for (let n = 1; n <= runs; n++) if (only.has('import')) await step(rung, 'import', n, () => importRun(rung, dir, n));
    // Reads go to the first import holding any history (a stopped import is read as far as it got).
    const target = rungState(rung).imports.find((i) => i.pushes?.some((p) => p?.ok));
    if (!target) {
      console.log(`${rung.name}: no imported history to read`);
      continue;
    }
    const secret = await token(target.id, ['read']);
    const url = `${values.api}/git/${target.id}.git`;
    for (let n = 1; n <= runs; n++)
      for (const op of Object.keys(reads)) if (only.has(op)) await step(rung, op, n, () => reads[op](rung, url, secret, target.id));
  }
  if (values.cleanup)
    for (const rs of Object.values(state.rungs))
      for (const i of rs.imports) {
        const r = await (await platform()).raw('DELETE', `/repos/${i.id}?confirm=${encodeURIComponent(i.name)}`);
        console.log(`deleted ${i.name}: ${r.status}`);
      }
} finally {
  for (const m of minted) {
    const r = await owner.raw('DELETE', `/repos/${m.repo}/tokens/${m.name}`);
    if (!r.ok) console.error(`Deleting token ${m.name} failed: ${r.status}; delete it by hand`);
  }
  save();
  console.log(`results: ${join(values.out, 'results.md')}`);
}
