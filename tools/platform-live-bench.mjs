#!/usr/bin/env node
// Hosted counterpart of tools/platform-load.mjs (N4) plus the Scion S12 cache gate, run
// against a deployed platform Worker with real Artifacts, DO SQLite, R2 and Cache API. An
// explicit, separate command: it creates two repositories and many commits on the target.
// Credentials come from YONEDA_USERNAME / YONEDA_PASSWORD. Evidence goes to
// .local/platform-live/bench.json.
// S19 baseline: time to first edit and bytes moved, `git clone` (the old agent flow) versus
// one API read (the platform flow), on the large repository.
// Usage: node tools/platform-live-bench.mjs --url https://<deployment> [--writers 100] [--large 10000]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { latency } from './load-metrics.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    writers: { type: 'string', default: '100' },
    large: { type: 'string', default: '10000' },
    // `session`: every writer uses the owner's session; `tokens`: each writer is its own
    // principal with a repository token (read, write, land), as separate agents would be.
    principals: { type: 'string', default: 'session' },
  },
});
assert.ok(values.url, 'Pass --url of the deployed platform');
const url = values.url.replace(/\/$/, '');
const WRITERS = Number(values.writers);
const LARGE = Number(values.large);
const root = fileURLToPath(new URL('../', import.meta.url));

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

async function call(path, body, token) {
  const started = performance.now();
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { cookie }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, body: value, ms: performance.now() - started, phases: phasesOf(response) };
}
/** The Worker's `Server-Timing` phases: {name: {ms, n}}. */
function phasesOf(response) {
  const phases = {};
  for (const part of (response.headers.get('server-timing') ?? '').split(',').filter(Boolean)) {
    const [name, ...fields] = part.trim().split(';');
    const field = (key) => fields.find((f) => f.startsWith(`${key}=`))?.slice(key.length + 1).replace(/"/g, '');
    phases[name] = { ms: Number(field('dur')), n: Number(field('desc')) };
  }
  return phases;
}
/** Per phase across requests: latency of its total time and mean calls per request. */
function breakdown(results) {
  const names = [...new Set(results.flatMap((r) => Object.keys(r.phases)))].sort();
  return Object.fromEntries(
    names.map((name) => {
      const seen = results.map((r) => r.phases[name]).filter(Boolean);
      const { p50_ms, p95_ms, max_ms } = latency(seen.map((p) => Math.round(p.ms)));
      return [name, { p50_ms, p95_ms, max_ms, calls_per_request: +(seen.reduce((n, p) => n + p.n, 0) / results.length).toFixed(2) }];
    }),
  );
}
const must = (result, what) => {
  assert.equal(result.status, 200, `${what}: ${result.body.error?.code} ${result.body.error?.message}`);
  return result.body;
};
const b64 = (text) => Buffer.from(text).toString('base64');
const file = (path, text) => ({ path, content_b64: b64(text) });
const author = { name: 'Live bench', email: 'bench@yonedarepo.invalid' };
async function repoWith(files) {
  const seed = Array.from({ length: files }, (_, i) => file(`seed/${Math.floor(i / 100)}/${i}.txt`, `seed ${i}\n`));
  const created = await call('/repos', { name: `bench${files}-${Date.now()}`, policy: { required_checks: [], approvals: 0 }, files: seed, author });
  return { id: must(created, `create ${files}-file repo`).id, ms: created.ms };
}

// N4: concurrent writers commit then land; warm bounded reads at the final head.
const small = await repoWith(100);
const repo = `/repos/${small.id}`;
const began = performance.now();
assert.ok(['session', 'tokens'].includes(values.principals), '--principals is session or tokens');
const tokens = [];
if (values.principals === 'tokens')
  for (let i = 0; i < WRITERS; i += 20)
    tokens.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(20, WRITERS - i) }, async (_, k) =>
          must(await call(`${repo}/tokens`, { name: `writer-${i + k}`, scopes: ['read', 'write', 'land'] }), 'token').token,
        ),
      )),
    );
const writes = await Promise.all(
  Array.from({ length: WRITERS }, async (_, i) => {
    const made = await call(`${repo}/commits`, { ref: 'main', changes: [file(`writers/${i}.txt`, `writer ${i}\n`)], message: `writer ${i}`, author }, tokens[i]);
    const landed = made.status === 200 ? await call(`${repo}/land`, { ref: 'main', commit: made.body.commit }, tokens[i]) : made;
    return { commit: made, land: landed };
  }),
);
const elapsed = performance.now() - began;
const reads = await Promise.all(Array.from({ length: WRITERS }, (_, i) => call(`${repo}/blob?path=writers/${i}.txt`)));
const readsOk = reads.filter((r, i) => r.status === 200 && r.body.content === `writer ${i}\n`).length;

// S12: fetch the head tree and its blobs twice; the second pass should come from the tiers
// above the object store. Each tier only asks the next one, so per-tier hit rate is
// served-at-tier / reached-tier.
const head = must(await call(`${repo}/commits/${writes.find((w) => w.land.status === 200)?.land.body.commit ?? ''}`), 'head commit');
const tiers = { edge: 0, r2: 0, store: 0 };
async function fetchAll(objects) {
  let after = null;
  do {
    const page = must(await call(`${repo}/objects`, { objects, after }), 'objects');
    for (const tier of Object.keys(tiers)) tiers[tier] += page.tiers[tier];
    after = page.next;
  } while (after !== null);
}
const tree = must(await call(`${repo}/tree?path=writers`), 'tree');
const blobs = tree.entries.filter((e) => e.type === 'blob').map((e) => ({ id: e.id, kind: 'blob' }));
await fetchAll([{ id: head.commit, kind: 'commit' }, ...blobs]); // warm
for (const tier of Object.keys(tiers)) tiers[tier] = 0;
await fetchAll([{ id: head.commit, kind: 'commit' }, ...blobs]);
const reached = tiers.edge + tiers.r2 + tiers.store;
const hitRates = {
  edge: reached ? tiers.edge / reached : null,
  r2: tiers.r2 + tiers.store ? tiers.r2 / (tiers.r2 + tiers.store) : null,
};

// S3: a one-file commit costs about the same in a small and a large repository.
const large = await repoWith(LARGE);
const edit = (id, k) => call(`/repos/${id}/commits`, { ref: 'main', changes: [file('seed/0/0.txt', `edit ${k}\n`)], message: 'edit', author });
for (let k = 0; k < 3; k++) await Promise.all([edit(small.id, k), edit(large.id, k)]);
const smallSamples = [];
const largeSamples = [];
const singles = [];
for (let k = 3; k < 23; k++) {
  for (const [id, samples] of [[small.id, smallSamples], [large.id, largeSamples]]) {
    const made = await edit(id, k);
    must(made, 'edit');
    samples.push(made.ms);
    if (samples === smallSamples) singles.push(made);
  }
}

// S19: the old flow cloned the repository before the first edit; the platform reads one file.
async function cloneBaseline(id) {
  const access = must(await call(`/repos/${id}/clone`, {}), 'clone access');
  const head = must(await call(`/repos/${id}/refs`), 'refs').refs['refs/heads/main'];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${access.token}` };
  const git = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  for (let waited = 0; git(['ls-remote', access.remote, 'refs/heads/main']).split(/\s/)[0] !== head; waited += 2000) {
    assert.ok(waited < 180_000, 'large repository main was not projected');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const runs = {};
  for (const [name, extra] of [['full', []], ['depth1', ['--depth=1']]]) {
    const dir = mkdtempSync(join(tmpdir(), 'yoneda-bench-'));
    try {
      const started = performance.now();
      git(['clone', '--quiet', ...extra, access.remote, dir]);
      const ms = performance.now() - started;
      const pack = Number(git(['count-objects', '-v'], dir).match(/size-pack: (\d+)/)?.[1] ?? 0) * 1024;
      runs[name] = { ms: Math.round(ms), pack_bytes: pack };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const reads = [];
  let bytes = 0;
  for (let k = 0; k < 10; k++) {
    const read = await call(`/repos/${id}/blob?path=seed/7/${700 + k}.txt`);
    must(read, 'api read');
    reads.push(read.ms);
    bytes = JSON.stringify(read.body).length;
  }
  return { git_clone: runs, api_first_read: { ...latency(reads), response_bytes: bytes } };
}
const baseline = await cloneBaseline(large.id);

const result = {
  writers: WRITERS,
  principals: values.principals,
  elapsed_ms: Math.round(elapsed),
  repo_create_ms: { small: Math.round(small.ms), large: Math.round(large.ms), large_files: LARGE },
  commits: latency(writes.filter((w) => w.commit.status === 200).map((w) => w.commit.ms)),
  commit_phases: breakdown(writes.filter((w) => w.commit.status === 200).map((w) => w.commit)),
  land_phases: breakdown(writes.filter((w) => w.land.status === 200).map((w) => w.land)),
  commit_failures: writes.filter((w) => w.commit.status !== 200).map((w) => w.commit.body.error?.code),
  landings: latency(writes.filter((w) => w.land.status === 200).map((w) => w.land.ms)),
  land_failures: writes.filter((w) => w.land.status !== 200).map((w) => w.land.body.error?.code),
  reads: latency(reads.map((r) => r.ms)),
  reads_correct: readsOk,
  tiers,
  hit_rates: hitRates,
  s3_commit_small: latency(smallSamples),
  single_commit_phases: breakdown(singles),
  s3_commit_large: latency(largeSamples),
  s19_time_to_first_edit: baseline,
};
const s3 = result.s3_commit_large.p50_ms <= result.s3_commit_small.p50_ms * 1.2 + 3;
const evidence = {
  schema: 1,
  target: url,
  gates: {
    commit_acceptance_p95_under_1s: result.commits.p95_ms < 1000,
    warm_reads_p95_under_1s: result.reads.p95_ms < 1000,
    all_commits_and_landings_succeeded: result.commit_failures.length === 0 && result.land_failures.length === 0,
    all_reads_correct: readsOk === WRITERS,
    s3_flat_commit_cost: s3,
    s12_edge_hit_rate_99: hitRates.edge !== null && hitRates.edge >= 0.99,
    s12_r2_hit_rate_99: hitRates.r2 !== null && hitRates.r2 >= 0.99,
  },
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  note: 'Hosted run from one client machine; latencies include the client network path.',
  result,
};
await mkdir(resolve(root, '.local/platform-live'), { recursive: true });
await writeFile(resolve(root, '.local/platform-live/bench.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
