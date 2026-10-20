#!/usr/bin/env node
// Many concurrent writers against a deployed platform Worker, driven through the bench
// client Worker (tools/fanout-bench) so the load is not capped by this machine's
// connections. Every writer commits one new file on main and lands it; then every file is
// read back. Reports client latency (measured in the bench client, aws:us-east-1) and the
// platform's Server-Timing totals, with correctness counts. An explicit, separate command:
// it creates a repository (and, with --principals tokens, one token per writer).
// Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the bench client.
// --mode picks the landing mode per request (changeset|batch), --begin where
// commits begin (authority|head) and --read where main reads are served (authority|head),
// where the target allows a per-request choice; changeset and batch runs also report how
// long main's Git projection lagged each landing.
// Usage: node tools/platform-fanout-bench.mjs --url https://<platform> --client https://<bench-client> [--writers 1000] [--principals tokens|session] [--mode changeset]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { latency } from './load-metrics.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    client: { type: 'string' },
    writers: { type: 'string', default: '1000' },
    principals: { type: 'string', default: 'tokens' },
    mode: { type: 'string' },
    begin: { type: 'string' },
    read: { type: 'string' },
  },
});
assert.ok(values.url && values.client, 'Pass --url (platform) and --client (bench client)');
assert.ok(['session', 'tokens'].includes(values.principals), '--principals is session or tokens');
assert.ok(!values.mode || ['changeset', 'batch'].includes(values.mode), '--mode is changeset or batch');
const url = values.url.replace(/\/$/, '');
const WRITERS = Number(values.writers);
const root = fileURLToPath(new URL('../', import.meta.url));

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const post = async (path, body) => {
  const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, 200, `${path}: ${value.error?.code} ${value.error?.message}`);
  return value;
};
const author = { name: 'Fanout bench', email: 'bench@yonedarepo.invalid' };
const seed = Array.from({ length: 100 }, (_, i) => ({ path: `seed/${i}.txt`, content_b64: Buffer.from(`seed ${i}\n`).toString('base64') }));
const repo = (await post('/repos', { name: `fanout${WRITERS}-${Date.now()}`, policy: { required_checks: [], approvals: 0 }, files: seed, author })).id;
const tokens = [];
if (values.principals === 'tokens')
  for (let i = 0; i < WRITERS; i += 50)
    tokens.push(...(await Promise.all(Array.from({ length: Math.min(50, WRITERS - i) }, async (_, k) => (await post(`/repos/${repo}/tokens`, { name: `w${i + k}`, scopes: ['read', 'write', 'land'] })).token))));
const who = (i) => (tokens[i] ? { token: tokens[i] } : { cookie });

/** Sends `writers` to the bench client in batches of five, all at once. */
async function fanout(writers) {
  const batches = [];
  for (let i = 0; i < writers.length; i += 5) batches.push(writers.slice(i, i + 5));
  const replies = await Promise.all(
    batches.map(async (batch) => {
      const response = await fetch(values.client, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-key': process.env.BENCH_KEY ?? '' },
        body: JSON.stringify({ target: url, repo, writers: batch }),
      });
      // A bench client invocation that failed outright counts its writers as failed.
      if (response.status !== 200) {
        const failed = { status: 0, error: 'BENCH_CLIENT', message: `bench client answered ${response.status}` };
        return batch.map((w) => (w.read ? { read: { ...failed, ok: false } } : { commit: failed, land: null }));
      }
      return (await response.json()).results;
    }),
  );
  return replies.flat();
}

const began = performance.now();
const writes = await fanout(Array.from({ length: WRITERS }, (_, i) => ({ ...who(i), mode: values.mode, begin: values.begin, path: `writers/${i}.txt`, content: `writer ${i}\n` })));
const elapsed = performance.now() - began;
const projection = await projectionLag();
const reads = await fanout(Array.from({ length: WRITERS }, (_, i) => ({ ...who(i), read: true, read_mode: values.read, version: writes[i]?.land?.version, path: `writers/${i}.txt`, content: `writer ${i}\n` })));

/** Waits (up to 5 min) until every changeset is projected; lag = projected - landed. */
async function projectionLag() {
  const started = Date.now();
  let refused = 0;
  for (;;) {
    const entries = [];
    for (let after = 0; ; after += 500) {
      const response = await fetch(`${url}/api/v1/repos/${repo}/txlog?after=${after}&limit=500`, { headers: { cookie } });
      const page = await response.json().catch(() => ({}));
      // A busy authority may refuse a log read; count it and read again.
      if (response.status !== 200) {
        refused++;
        await new Promise((r) => setTimeout(r, 1000));
        after -= 500;
        continue;
      }
      entries.push(...page.entries);
      if (page.entries.length < 500) break;
    }
    const changes = entries.filter((e) => e.kind === 'changeset');
    const pending = changes.filter((e) => !e.projected?.at).length;
    if (!pending || Date.now() - started > 300_000)
      return { changesets: changes.length, unprojected: pending, refused_reads: refused, lag: latency(changes.filter((e) => e.projected?.at).map((e) => e.projected.at - e.committed_at_ms)) };
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const ok = (r) => r?.status === 200;
const stat = (rows, key) => latency(rows.filter((r) => ok(r) && r[key] !== null).map((r) => r[key]));
const commits = writes.map((w) => w.commit);
const lands = writes.map((w) => w.land).filter(Boolean);
const errors = (rows) => {
  const counts = {};
  for (const r of rows.filter((r) => r && !ok(r))) {
    const key = `${r.status} ${r.error}: ${r.message ?? ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts);
};
/** Per Server-Timing phase: latency of its total across requests. */
function phases(rows, failed = false) {
  const all = {};
  for (const r of rows.filter((r) => r && (failed || ok(r))))
    for (const part of (r.timing ?? '').split(',').filter(Boolean)) {
      const [name, dur, desc] = part.trim().split(';');
      (all[name] ??= []).push(Number(dur?.slice(4)));
      // The count a phase covered (its desc), e.g. a land batch's size.
      if (name === 'land.batch') (all[`${name}.size`] ??= []).push(Number(desc?.match(/\d+/)?.[0]));
    }
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, latency(v)]));
}
/** The most landings answered within any one second (throughput while work is queued,
 * apart from how fast the load generator sends it). */
function landPeak(rows) {
  const ends = rows.filter(ok).map((r) => r.started_at + r.ms).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; j < ends.length; j++) {
    while (ends[j] - ends[i] >= 1000) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

/** Successful landings per second, from the first landing request to the last answer. */
function landRate(rows) {
  const done = rows.filter(ok);
  if (!done.length) return 0;
  const first = Math.min(...done.map((r) => r.started_at));
  const last = Math.max(...done.map((r) => r.started_at + r.ms));
  return Number(((done.length * 1000) / Math.max(1, last - first)).toFixed(1));
}
const result = {
  repo,
  writers: WRITERS,
  principals: values.principals,
  mode: values.mode ?? 'default',
  begin: values.begin ?? 'default',
  read_mode: values.read ?? 'default',
  elapsed_ms: Math.round(elapsed),
  commit: { client: stat(commits, 'ms'), server: stat(commits, 'server'), ok: commits.filter(ok).length, errors: errors(commits), phases: phases(commits) },
  land: { client: stat(lands, 'ms'), server: stat(lands, 'server'), ok: lands.filter(ok).length, errors: errors(lands), phases: phases(lands), per_second: landRate(lands), peak_per_second: landPeak(lands) },
  projection,
  overloaded: [...commits, ...lands].filter((r) => r && !ok(r) && /overloaded/i.test(r.message ?? '')).length,
  read: { client: stat(reads.map((r) => r.read), 'ms'), correct: reads.filter((r) => r.read.ok).length, errors: errors(reads.map((r) => r.read)), phases: phases(reads.map((r) => r.read), true) },
};
const evidence = {
  schema: 1,
  target: url,
  client: 'bench client Worker, aws:us-east-1',
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  result,
};
await mkdir(resolve(root, '.local/platform-live'), { recursive: true });
await writeFile(resolve(root, `.local/platform-live/fanout-${WRITERS}-${values.principals}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
