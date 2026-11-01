// The regional clients' and real-use simulation's pure parts: what they refuse, how they judge,
// and that the plan comes from the scripts. docs/load-testing.md and docs/global-scale-plan.md
// describe them; real requests are in tests/workers/real-use-scripts.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blobIds, cloneSteps, commitPack, flatTree, pushSteps } from '../../tools/fanout-bench/git-forms.mjs';
import { joined, netCreate, sample } from '../../tools/fanout-bench/region-matrix.mjs';
import { describeMatrix, estimateMatrix, pairRequests, repoName, seedFiles } from '../../tools/fanout-bench/region-plan.mjs';
import { probe, validProbe } from '../../tools/fanout-bench/region-probe.js';
import { latencyTable, placementTable, renderRegionResults, replaceRegionResults } from '../../tools/fanout-bench/region-results.mjs';
import { runStep, runSteps, validSteps } from '../../tools/fanout-bench/region-steps.js';
import { clientUrl, placedClients, regionalClients } from '../../tools/fanout-bench/regions.mjs';
import { describeRun, estimateRun, perSession } from '../../tools/real-use/estimate.mjs';
import { activity, DEFAULTS, MIX, peakLoad, randomStream, ratePerMinute, simHour, zipfIndex, ZONES } from '../../tools/real-use/plan.mjs';
import { failed, judge, playDay, TARGETS } from '../../tools/real-use/run.mjs';
import { classOf, SCRIPTS } from '../../tools/real-use/sessions.mjs';
import { renderSummary, summarize } from '../../tools/real-use/summary.mjs';

const REPO = `r${'a'.repeat(20)}`;
const stubbedFetch = (answer) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return answer(url, init);
  };
  return { seen, restore: () => void (globalThis.fetch = original) };
};

test('a step reports timing, where it ran and what failed, and never throws', async () => {
  const stub = stubbedFetch(() => new Response('{"a":1}', { headers: { 'server-timing': 'auth;dur=3.0, total;dur=12.5', 'cf-ray': 'abc-FRA', 'cf-placement': 'remote-IAD' } }));
  const good = await runStep('https://x', { label: 'blob', path: '/p', token: 't', keep: true });
  stub.restore();
  assert.deepEqual([good.ok, good.server, good.edge, good.placement, good.value], [true, 12.5, 'FRA', 'remote-IAD', { a: 1 }]);
  assert.equal(stub.seen[0].init.headers.authorization, 'Bearer t');
  assert.equal(stub.seen[0].init.headers['x-yoneda-own-traffic'], '1');

  const refused = stubbedFetch(() => new Response('{"error":{"code":"FORBIDDEN","message":"no"}}', { status: 403 }));
  const answer = await runStep('https://x', { label: 'blob', path: '/p', keep: true });
  refused.restore();
  assert.deepEqual([answer.ok, answer.status, answer.error, answer.message, answer.value], [false, 403, 'FORBIDDEN', 'no', undefined]);

  const lost = stubbedFetch(() => {
    throw new Error('reset');
  });
  const none = await runStep('https://x', { label: 'blob', path: '/p' });
  lost.restore();
  assert.deepEqual([none.status, none.ok, none.error], [0, false, 'CLIENT_FETCH']);
});

test('a step that must hold a text fails without it, and bytes go as bytes', async () => {
  const stub = stubbedFetch((_, init) => new Response(init.body));
  const body_b64 = Buffer.from([0, 1, 2]).toString('base64');
  const [fine, wrong] = await runSteps('https://x', [
    { label: 'a', path: '/a', body_b64 },
    { label: 'b', path: '/b', json: { a: 1 }, contains: 'nothing like it' },
  ]);
  stub.restore();
  assert.equal(fine.bytes, 3);
  assert.deepEqual([wrong.ok, wrong.error], [false, 'WRONG_CONTENT']);
});

test('the Worker takes only small, well-formed batches', () => {
  assert.ok(validSteps([{ label: 'clone.pack', path: '/git/x' }]));
  for (const bad of [[], 'x', [{ label: 'a', path: 'relative' }], [{ label: 'a', path: '//elsewhere' }], [{ label: 'BAD LABEL', path: '/a' }], Array(13).fill({ label: 'a', path: '/a' })]) assert.ok(!validSteps(bad), JSON.stringify(bad).slice(0, 60));
  assert.ok(validProbe({ samples: 3, account: 'kit', repos: [{ id: REPO, data: 'weur' }] }));
  for (const bad of [{ samples: 0, account: 'kit', repos: [] }, { samples: 3, account: 'kit', repos: [{ id: 'nope', data: 'x' }] }, { samples: 99, account: 'kit', repos: [] }, { samples: 3, account: 'a b', repos: [] }]) assert.ok(!validProbe(bad));
});

test('the probe times each piece through its binding, and a failed piece says so', async () => {
  const stub = stubbedFetch(() => new Response('colo=FRA\nloc=DE\n'));
  const namespace = (text) => ({ idFromName: (n) => n, get: () => ({ fetch: async () => new Response(text) }) });
  const env = {
    INDEX: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { served_by_region: 'ENAM', served_by_primary: true } }) }) }) },
    WORKSPACES: namespace('{}'),
    OBJECTS: { head: async () => null, list: async () => ({ objects: [{ key: 'k', size: 9 }] }), get: async () => ({ arrayBuffer: async () => new ArrayBuffer(9) }) },
    SOURCE_REPOS: namespace('{"db_bytes":1}'),
    COMMIT_SHARDS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('down', { status: 500 }) }) },
  };
  const out = await probe(env, 'https://x', { samples: 3, account: 'kit', repos: [{ id: REPO, data: 'weur' }] });
  stub.restore();
  assert.deepEqual(Object.keys(out.pieces), ['trace', 'platform_health', 'd1', 'account_authority', 'r2_head', 'r2_get', 'repo_weur', 'shard_weur']);
  assert.equal(out.pieces.repo_weur.ms.length, 2, 'the first sample is kept apart');
  assert.equal(out.pieces.repo_weur.failed, 0);
  assert.deepEqual([out.pieces.shard_weur.failed, out.pieces.shard_weur.ms.length], [3, 0]);
  assert.match(out.pieces.shard_weur.error, /shard read: 500/);
  assert.equal(out.d1.served_by_region, 'ENAM');
});

test('clients are refused off dev, and refused together when placement did not apply', async () => {
  assert.throws(() => regionalClients({ key: 'k', target: 'https://api.yonedarepo.com' }), /dev only/);
  assert.match(clientUrl('eu'), /^https:\/\/yonedarepo-dev-region-eu\./);
  const answers = { na: { bench: 1, colo: 'IAD' }, eu: { bench: 1, colo: 'IAD' } };
  await assert.rejects(placedClients({ call: async (n) => answers[n] }, ['na', 'eu']), /not apart/);
  await assert.rejects(placedClients({ call: async () => ({ failed: 'gone' }) }, ['na']), /deploy the regional clients/);
  await assert.rejects(placedClients({ call: async () => ({ bench: 0, colo: 'IAD' }) }, ['na']), /deploy it/);
  const fine = await placedClients({ call: async (n) => ({ bench: 1, colo: n === 'na' ? 'IAD' : 'FRA' }) }, ['na', 'eu']);
  assert.equal(fine.eu.colo, 'FRA');
});

test('a pack made here is one real Git accepts, with the ids the platform will compute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yoneda-pack-'));
  try {
    const git = (args, input) => spawnSync('git', args, { cwd: dir, input, encoding: input ? undefined : 'utf8' });
    assert.equal(git(['init', '-q', '--bare', '.']).status, 0);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const made = git(['hash-object', 'a.txt']).stdout.trim();
    assert.equal(blobIds({ 'a.txt': 'hello\n' })['a.txt'], made);
    const { commit, pack } = commitPack({ parent: 'a'.repeat(40), files: { 'a.txt': made }, name: 'b.txt', text: 'b\n', at: 1 });
    const indexed = git(['index-pack', '--stdin'], pack);
    assert.equal(indexed.status, 0, String(indexed.stderr));
    assert.match(git(['cat-file', '-p', commit]).stdout, /^tree [0-9a-f]{40}\nparent a{40}\n/);
    assert.equal(flatTree({ 'a.txt': made }).id.length, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Git forms read and write what they should, with the token as a credential only', () => {
  const clone = cloneSteps(REPO, 'tok', 'c'.repeat(40));
  assert.deepEqual(clone.map((s) => s.label), ['clone.refs', 'clone.ls', 'clone.pack']);
  assert.ok(Buffer.from(clone[2].body_b64, 'base64').toString().includes(`want ${'c'.repeat(40)}`));
  const push = pushSteps(REPO, 'tok', { ref: 'refs/heads/x', commit: 'd'.repeat(40), pack: Buffer.from('PACK') });
  assert.equal(push[1].contains, 'ok refs/heads/x');
  assert.ok(!JSON.stringify([...clone.map((s) => s.body_b64), push[1].body_b64]).includes(Buffer.from('tok').toString('base64')));
});

test('a create is compared without the wait only a hinted create has', () => {
  const row = { ms: 5000, server: 4000, timing: 'total;dur=4000, create.shards;dur=1500.0, create.place;dur=500.0' };
  assert.deepEqual([netCreate(row).ms, netCreate(row).server, netCreate(row).ms_raw], [3000, 2000, 5000]);
  assert.equal(netCreate({ ms: 9, server: null }).ms, 9);
  const one = joined([{ label: 'a', ms: 1, server: 2, ok: true, timing: '' }, { label: 'b', ms: 3, server: null, ok: false, status: 500, error: 'X', timing: '' }]);
  assert.deepEqual([one.ms, one.server, one.ok, one.error], [4, null, false, 'X']);
  assert.equal(sample({ ms: 1, value: { tokens: ['secret'] } }).value, undefined);
});

test('the matrix plan is the sequence it sends', () => {
  assert.equal(repoName('s', 1, 'eu', 'weur'), 'region-hint-s-1-eu-weur');
  const o = { reads: 2, clones: 1, lands: 1, pushes: 1 };
  assert.equal(pairRequests(o), 2 + 6 + 3 + 2 + 2);
  const e = estimateMatrix();
  assert.equal(e.pairs, 27);
  assert.match(describeMatrix(e), /27 test repositories made and deleted/);
  const files = seedFiles('a', 3);
  assert.equal(Object.keys(files).length, 3);
  assert.notEqual(seedFiles('b', 3)['f00.txt'], files['f00.txt'], 'no shared content, so no shared cache');
});

const record = (pairs, extra = {}) => ({ revision: 'a'.repeat(40), recorded_at: '2026-10-31T00:00:00Z', result: { runs: 1, clients: { na: { colo: 'IAD', loc: 'US' } }, pairs, probes: [], mac_git: [], ...extra } });
const opRow = (ms) => ({ ok: true, ms, server: ms / 2 });

test('results come from evidence: failures are counted, not averaged, and gaps say so', () => {
  const pair = (ms) => ({ client: 'eu', data: 'weur', where: { authority: 'FRA', shard: 'AMS' }, ops: { read_token: [opRow(9999), opRow(ms), opRow(ms + 2)], land: [opRow(ms), { ok: false, ms: 1, status: 500 }] } });
  const table = latencyTable([record([pair(100), pair(200), pair(300)])], 'ms');
  const row = table.split('\n').find((l) => l.startsWith('| Europe | weur'));
  assert.match(row, /\| 200 \(100–300\) \|/, 'the cold first read is out, and each run counts once');
  assert.match(row, /\(3 failed\)/);
  assert.ok(table.split('\n').find((l) => l.startsWith('| Asia | apac')).includes('not measured'));
  assert.match(placementTable([record([pair(1)])]), /\| weur \| 1 \| FRA ×1 \| AMS ×1 \| unread ×1/);
  assert.equal(renderRegionResults([]), 'None yet.');
  assert.throws(() => replaceRegionResults('no markers', 'x'), /markers are missing/);
});

test('the day has a rhythm, follows the sun and sums to the plan', () => {
  assert.equal(activity('person', 3), 0.02);
  assert.equal(activity('person', 10), 1);
  assert.equal(activity('agent', 3), 0.3, 'some agents run all night');
  assert.equal(simHour(30, 60), 12);
  assert.equal(simHour(45, 60, 6), 0);
  assert.ok(ratePerMinute('browse', 'eu', 10 - ZONES.eu.utc, 100) > 10 * ratePerMinute('browse', 'eu', 2 - ZONES.eu.utc, 100));
  assert.ok(ratePerMinute('browse', 'ap', 2, 100) > ratePerMinute('browse', 'na', 2, 100), 'Asia is at work while America sleeps');
  assert.ok(Math.abs(Object.values(MIX).reduce((n, m) => n + m.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(Object.values(ZONES).reduce((n, z) => n + z.share, 0) - 1) < 1e-9);
  let busiest = 0;
  for (let h = 0; h < 24; h += 0.25) busiest = Math.max(busiest, Object.keys(MIX).reduce((n, k) => n + Object.keys(ZONES).reduce((m, r) => m + ratePerMinute(k, r, h, 100), 0), 0));
  assert.ok(Math.abs(busiest - 100) < 1e-6, `peak ${busiest}, load ${peakLoad()}`);
});

test('a seed repeats a run, and popular repositories take most sessions', () => {
  assert.equal(randomStream(5)(), randomStream(5)());
  const random = randomStream(1);
  const hits = [0, 0, 0];
  for (let i = 0; i < 3000; i++) hits[zipfIndex(random, 3)]++;
  assert.ok(hits[0] > hits[1] && hits[1] > hits[2]);
});

test('the plan is counted from the scripts, and every script is in the mix', async () => {
  assert.deepEqual(Object.keys(SCRIPTS).sort(), Object.keys(MIX).sort());
  const kinds = await perSession();
  assert.ok(kinds.agent.labels.commit > 0.9, 'an agent commits');
  assert.ok(kinds.agent.labels['change.open'] > 0.9, 'and opens a Landing');
  assert.ok(kinds.browse.labels.blob >= 1);
  assert.ok(kinds.git.labels['clone.pack'] === 1);
  assert.ok(kinds.review.labels.review > 0.9);
  const e = await estimateRun();
  assert.ok(e.requests > 10_000 && e.requests < 300_000, `about ${e.requests} requests is a real hour, not a hammer`);
  assert.ok(e.peakRequestsPerSecond < 100, `peak ${e.peakRequestsPerSecond}/s`);
  assert.match(describeRun(e), /Cost basis/);
  assert.equal(e.minutes, DEFAULTS.minutes);
});

test('stop rules judge the last minute by class, and a conflict is ordinary life', () => {
  const rows = (label, n, extra) => Array.from({ length: n }, () => ({ label, ok: true, ms: 50, status: 200, ...extra }));
  assert.deepEqual(judge(rows('blob', 100)), []);
  assert.match(judge([...rows('blob', 90), ...rows('blob', 10, { ok: false, status: 500, error: 'INTERNAL' })])[0], /^read: errors/);
  assert.match(judge(rows('land', 40, { ms: TARGETS.write * 4 }))[0], /^write: p95/);
  assert.match(judge([...rows('blob', 30), ...rows('blob', 1, { ok: false, status: 503, error: 'OVERLOADED', message: 'too many requests queued' })])[0], /limit/);
  assert.deepEqual(judge(rows('blob', 5, { ok: false, status: 500 })), [], 'too few to judge');
  const conflict = { ok: false, status: 409, error: 'CONFLICT' };
  assert.equal(failed(conflict), false);
  assert.deepEqual(judge([...rows('land', 30), ...rows('land', 20, conflict)]), []);
  assert.equal(classOf('clone.pack'), 'git');
  assert.equal(classOf('commit'), 'write');
  assert.equal(classOf('blob'), 'read');
});

const plan = (o) => ({ ...DEFAULTS, peakPerMinute: 6000, maxSessions: 50, minutes: 0.02, settleMs: 2000, ...o });
const person = (kind, region, random) => ({ person: 0, target: 'https://x', credential: 't', repo: { id: REPO, paths: ['f.txt'], blobs: {}, seed_commit: 'd'.repeat(40) } });

test('a day plays, stops when the platform breaks, and reports what happened', async () => {
  const send = async (_region, _target, steps) => ({ results: steps.map((s) => ({ label: s.label, started_at: Date.now(), status: 200, ok: true, ms: 5, server: 2, timing: '' })) });
  const day = await playDay({ plan: plan(), population: person, send, assets: [], tickMs: 5, sideJobs: [] });
  assert.equal(day.stopped, 'finished');
  assert.ok(day.counts.started > 0 && day.rows.length > 0);
  const summary = summarize(day, { plan: plan({ accounts: 1, reposPerAccount: 1, peakSessions: 1 }), placed: {}, sampler: null });
  assert.equal(summary.all.failed, 0);
  assert.ok(renderSummary(summary).includes('| Region, class |'));

  const broken = async (_region, _target, steps) => ({ results: steps.map((s) => ({ label: s.label, started_at: Date.now(), status: 500, ok: false, ms: 5, server: null, error: 'INTERNAL', timing: '' })) });
  const stopped = await playDay({ plan: plan({ minutes: 0.2 }), population: person, send: broken, assets: [], tickMs: 5, sideJobs: [] });
  assert.match(stopped.stopped, /errors/);
  assert.ok(stopped.ms < 0.2 * 60_000);
});
