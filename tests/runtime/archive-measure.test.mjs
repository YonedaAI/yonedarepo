// Archive stage A's measurement: what it plans, what it refuses, that sizes are read only once
// work has settled, and what its tables say. Stand-ins replace the platform; no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, DEV_JSON_CHANGE, describe, estimate, PROTECTED, repoName, requireArm, requireMeasured, runRequests, specSwitches, SWITCHES } from '../../tools/archive-measure/plan.mjs';
import { checksHeld, COSTS, METRICS, perBranch, renderArchive, replaceArchive, span, table } from '../../tools/archive-measure/report.mjs';
import { baseline, importArm, measureRun, settled, sizes, sweepWouldMove } from '../../tools/archive-measure/run.mjs';

const tool = fileURLToPath(new URL('../../tools/platform-archive-measure.mjs', import.meta.url));
const REPO = `r${'b'.repeat(20)}`;
const now = { fast: { wait: async () => {}, look: 0, limit: 2_000 } };

/** A platform stand-in: `sizes()` scripts each size read, and each call is listed. */
function standIn({ size = () => ({}), answers = {} } = {}) {
  const calls = [];
  const usage = { authority: 1000, shards: 500 };
  const raw = async (method, path, body) => {
    calls.push([method, path, body]);
    const route = path.replace(`/api/v1/repos/${REPO}`, '');
    const body2 = (() => {
      if (route.startsWith('/compaction')) {
        const u = { ...usage, ...size(calls.length) };
        return { floor: 0, head: 10, tail_rows: 10, retention: { keep_versions: 10_000 }, storage: { db_bytes: u.authority, table_rows: { commits: 1 } }, shards: { db_bytes: u.shards, table_rows: {} } };
      }
      if (route === '/refs') return { refs: { 'refs/heads/main': 'c'.repeat(40) } };
      if (route === '') return { objects: { pending: 0 }, projections: [] };
      if (route.endsWith('/check-runs')) return { runs: [{ id: `run-${calls.length}` }] };
      if (route.startsWith('/check-runs/') && route.endsWith('/log')) return { log: 'measured' };
      if (route.startsWith('/check-runs/')) return { id: route.split('/')[2], status: 'passed', result: { evidence: 'x'.repeat(40) } };
      return answers[route] ?? {};
    })();
    return { status: 200, ok: true, body: body2, ms: 12, headers: new Headers({ 'server-timing': 'total;dur=7.5' }) };
  };
  return { calls, raw };
}
const bench = () => ({
  mintTokens: async (_, n) => Array(n).fill('t'),
  revokeTokens: async () => 0,
  fanout: async (_, list) => list.map((_w, i) => ({ commit: { status: 200, ms: 5, server: 2, commit: `${i}`.padStart(40, '0') }, land: { status: 200, ms: 9, server: 3 } })),
});

test('the estimate comes from the plan, and the deploy between arms is said aloud', () => {
  const e = estimate();
  assert.equal(e.requests_per_run, runRequests(DEFAULTS));
  assert.equal(e.requests_all, 6 * e.requests_per_run);
  assert.equal(e.container_runs_all, 24);
  assert.match(describe(e), /A deploy with the switches comes between the arms/);
  for (const name of SWITCHES) assert.match(DEV_JSON_CHANGE, new RegExp(`"${name}": "on"`));
  assert.doesNotThrow(() => JSON.parse(`{${DEV_JSON_CHANGE}}`));
});

test('only its own imports can be written to, whatever a saved file says', () => {
  for (const name of [...PROTECTED, 'yonedarepo', undefined]) assert.throws(() => requireMeasured(name), /Refusing/);
  assert.equal(requireMeasured(repoName('on', 'x')), 'archive-measure-on-x');
});

test('an arm the spec does not describe is refused before any sign-in', () => {
  const spec = (vars) => JSON.stringify({ workers: [{ role: 'platform', config: { vars } }] });
  assert.deepEqual(specSwitches(spec({ REF_CHAIN_SHARED: 'on' })), { CHECK_EVIDENCE_ONCE: 'off', REF_CHAIN_SHARED: 'on', SHARD_FORGET_RECORDED: 'off', COMPACTION_SWEEP: 'off' });
  assert.throws(() => requireArm('on', specSwitches(spec({ REF_CHAIN_SHARED: 'on' }))), /CHECK_EVIDENCE_ONCE, SHARD_FORGET_RECORDED, COMPACTION_SWEEP on/);
  assert.doesNotThrow(() => requireArm('off', specSwitches(spec({}))));
  const refused = spawnSync('node', [tool, '--arm', 'on', '--yes'], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Arm on needs/);
  const dry = spawnSync('node', [tool, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.match(dry.stderr, /"SHARD_FORGET_RECORDED": "on"/);
  const prod = spawnSync('node', [tool, '--dry-run', '--url', 'https://api.yonedarepo.com'], { encoding: 'utf8' });
  assert.match(prod.stderr, /dev only/);
});

test('a size is taken only when nothing is pending and two reads agree', async () => {
  let reads = 0;
  const api = standIn({ size: () => ({ shards: [900, 700, 500, 500][Math.min(reads++, 3)] }) });
  const size = await settled(api, REPO, now.fast);
  assert.equal(size.shards, 500);
  assert.equal(size.settled, true);
  assert.equal(reads, 4);
});

test('a size that never settles says so', async () => {
  let reads = 0;
  const api = standIn({ size: () => ({ shards: reads++ }) });
  const size = await settled(api, REPO, { ...now.fast, limit: -1 });
  assert.equal(size.settled, false);
});

test('an older build says to deploy rather than measuring nothing', async () => {
  const api = { raw: async () => ({ status: 200, ok: true, body: { storage: {} }, ms: 1, headers: new Headers() }) };
  await assert.rejects(sizes(api, REPO), /deploy it first/);
});

test('a run does the work in order and charges each step only what it added', async () => {
  const api = standIn();
  const result = await measureRun({ api, session: bench(), repo: REPO, name: 'archive-measure-off-x', run: 1, options: { ...DEFAULTS, branches: 2, landings: 5, checks: 2 }, log: () => {}, timing: now.fast });
  const posts = api.calls.filter(([m]) => m === 'POST').map(([, p]) => p.replace(/.*\/repos\/r[b]+/, ''));
  assert.deepEqual(posts.slice(0, 4), ['/branches', '/commits', '/branches', '/commits']);
  assert.equal(posts.filter((p) => p.endsWith('/check-runs')).length, 2);
  const [branch] = api.calls.filter(([m, p]) => m === 'POST' && p.endsWith('/branches'));
  assert.deepEqual(branch[2], { ref: 'measure/1/0', commit: 'c'.repeat(40) });
  assert.equal(result.steps.landings.count, 5);
  assert.equal(result.steps.branches.move.server.p50_ms, 7.5);
  assert.deepEqual(result.steps.checks.evidence_bytes, [55, 55]);
  assert.equal(result.steps.checks.logs_readable, 2);
});

test('a run on any repository but its own does not start', async () => {
  const api = standIn();
  await assert.rejects(measureRun({ api, session: bench(), repo: REPO, name: 'oss-click', run: 1, options: DEFAULTS, log: () => {} }), /Refusing/);
  assert.equal(api.calls.length, 0);
});

test('the baseline only reads, and only the protected repositories', async () => {
  const api = standIn();
  const rows = await baseline(api, [{ id: REPO, name: 'oss-click' }, { id: REPO, name: 'somebody-else' }]);
  assert.deepEqual(rows.map((r) => r.name), ['oss-click']);
  assert.deepEqual([...new Set(api.calls.map(([m]) => m))], ['GET']);
});

test('a sweep moves only what is past the retention, by whole segments', () => {
  assert.equal(sweepWouldMove({ tail_rows: 10_000, keep_versions: 10_000 }), 0);
  assert.equal(sweepWouldMove({ tail_rows: 13_000, keep_versions: 10_000 }), 2);
  assert.equal(sweepWouldMove({ tail_rows: null, keep_versions: 10_000 }), null);
});

test('an import is its own repository, private, and sets the policy that gates nothing', async () => {
  const states = ['running', 'complete'];
  const api = standIn({ answers: { '/import': { status: 'complete' } } });
  const raw = api.raw;
  api.raw = async (method, path, body) => {
    if (path === '/api/v1/repos/import') return { status: 200, ok: true, body: { id: REPO }, ms: 1, headers: new Headers() };
    if (path.endsWith('/import')) return { status: 200, ok: true, body: { status: states.shift() }, ms: 1, headers: new Headers() };
    return raw(method, path, body);
  };
  const repo = await importArm(api, { name: 'archive-measure-on-1', source: 'expressjs/express', maxCommits: 5000, wait: async () => {} });
  assert.equal(repo.id, REPO);
  const [, , policy] = api.calls.find(([m]) => m === 'PUT');
  assert.deepEqual(policy.policy.required_checks, []);
  await assert.rejects(importArm(api, { name: 'oss-click', source: 'x/y', maxCommits: 1 }), /Refusing/);
});

const run = ({ branch, landing, shards, evidence = 400, land = 80, settledOk = true }) => ({
  after: { settled: settledOk },
  steps: {
    branches: { count: 10, bytes: { authority: branch * 10 }, move: { server: { p50_ms: 20, p95_ms: 30 } }, commit: { server: { p50_ms: 25 } } },
    landings: { count: 100, bytes: { authority: landing * 100, shards: shards * 100 }, commit: { server: { p50_ms: 40 } }, land: { server: { p50_ms: land, p95_ms: land * 2 } } },
    checks: { asked: 2, passed: 2, logs_readable: 2, evidence_bytes: [evidence, evidence] },
  },
});

test('the tables report each measure with its range and how far it moved', () => {
  const off = [run({ branch: 400_000, landing: 4000, shards: 1500, land: 80 }), run({ branch: 410_000, landing: 4100, shards: 1500, land: 90 }), run({ branch: 390_000, landing: 3900, shards: 1500, land: 85 })];
  const on = off.map(() => run({ branch: 4000, landing: 4000, shards: 0, evidence: 0, land: 85 }));
  assert.deepEqual(span([3, 1, 2]), { min: 1, median: 2, max: 3 });
  assert.equal(span([NaN]), null);
  assert.match(table('Saves', METRICS, off, on), /\| Bytes per new branch, authority \| 400000 \(390000–410000\) \| 4000 \(4000–4000\) \| -99% \|/);
  assert.match(table('Saves', METRICS, off, on), /\| Bytes per landing left in shards \| 1500 \(1500–1500\) \| 0 \(0–0\) \| -100% \|/);
  assert.match(table('Costs', COSTS, off, on), /\| Land, server p50 \| 85 \(80–90\) \| 85 \(85–85\) \| 0% \|/);
  assert.deepEqual(perBranch(off, on, 10), { landings: 10, off_bytes: 455_000, on_bytes: 44_000, life_multiple: 10.34 });
  assert.deepEqual(checksHeld(off), { asked: 6, passed: 6, logs_readable: 6 });
  assert.match(renderArchive({ off, on: [] }), /3 runs with the switches off, 0 on/);
  assert.match(renderArchive({ off, on: [run({ branch: 1, landing: 1, shards: 1, settledOk: false })] }), /1 runs never settled/);
  assert.equal(renderArchive({}), 'None yet.');
  const owners = renderArchive({ baseline: { repositories: [{ name: 'oss-click', head: 9, tail_rows: 9, authority: 2e6, shards: 1e6, sweep_would_move: 0 }, { name: 'testing', unreadable: 404 }] } });
  assert.match(owners, /\| oss-click \| 9 \| 9 \| 2\.0 \| 1\.0 \| 0 \|/);
  assert.match(owners, /unreadable \(404\)/);
  assert.match(owners, /don't shrink/);
});

test('results replace only what lies between their markers', () => {
  const doc = 'a\n<!-- archive-results:start (tools/platform-archive-measure.mjs --results) -->\nold\n<!-- archive-results:end -->\nb\n';
  assert.equal(replaceArchive(doc, 'new'), doc.replace('old', 'new'));
  assert.throws(() => replaceArchive('a', 'new'), /lost its archive results markers/);
});
