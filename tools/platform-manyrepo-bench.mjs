#!/usr/bin/env node
// Many repositories at once against a deployed platform Worker: every repository gets its
// own writers (each commits one new file on main and lands it, all repositories side by
// side through the bench client Worker, tools/fanout-bench), then one post-land check on
// its main head. Reports landing throughput across repositories, per-repository landing
// latency, commit latency, overload refusals, check queue wait and container cold starts.
// An explicit, separate command: it creates repositories and tokens on the target.
// Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the bench client.
// Usage: node tools/platform-manyrepo-bench.mjs --url https://<platform> --client https://<bench-client> [--repos 100] [--writers 10]
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
    repos: { type: 'string', default: '100' },
    writers: { type: 'string', default: '10' },
  },
});
assert.ok(values.url && values.client, 'Pass --url (platform) and --client (bench client)');
const url = values.url.replace(/\/$/, '');
const REPOS = Number(values.repos);
const WRITERS = Number(values.writers);
const root = fileURLToPath(new URL('../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${url}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((e) => ({ status: 0, json: async () => ({ error: { code: 'CLIENT_FETCH', message: String(e) } }) }));
    const value = await response.json().catch(() => ({}));
    // Setup and check bookkeeping retry a refused request; the measured phase never does.
    if (response.status === 200) return value;
    if (attempt >= 4) throw new Error(`${method} ${path}: ${response.status} ${value.error?.code} ${value.error?.message}`);
    await sleep(500 * (attempt + 1));
  }
}
/** Runs `work` over `items`, `width` at a time. */
async function waves(items, width, work) {
  const out = [];
  for (let i = 0; i < items.length; i += width) out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return out;
}

// Setup (not measured): repositories, then one token per writer.
const author = { name: 'Many-repo bench', email: 'bench@yonedarepo.invalid' };
const stamp = Date.now();
const repos = await waves(Array.from({ length: REPOS }, (_, i) => i), 20, async (i) => {
  const created = await api('POST', '/repos', {
    name: `many${REPOS}x${WRITERS}-${stamp}-${i}`,
    policy: { required_checks: [], approvals: 0 },
    files: [{ path: 'README.md', content_b64: Buffer.from(`repo ${i}\n`).toString('base64') }],
    author,
  });
  return { id: created.id, tokens: [] };
});
await waves(repos, 10, async (repo) => {
  repo.tokens = await Promise.all(
    Array.from({ length: WRITERS }, async (_, k) => (await api('POST', `/repos/${repo.id}/tokens`, { name: `w${k}`, scopes: ['read', 'write', 'land'] })).token),
  );
});

/** Sends one repository's writers to the bench client in batches of five, every repository at once. */
async function fanout() {
  const batches = [];
  for (const repo of repos)
    for (let k = 0; k < WRITERS; k += 5)
      batches.push({ repo: repo.id, writers: repo.tokens.slice(k, k + 5).map((token, j) => ({ token, path: `writers/${k + j}.txt`, content: `writer ${k + j}\n` })) });
  const replies = await Promise.all(
    batches.map(async (batch) => {
      const response = await fetch(values.client, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bench-key': process.env.BENCH_KEY ?? '' },
        body: JSON.stringify({ target: url, repo: batch.repo, writers: batch.writers }),
      }).catch(() => null);
      if (response?.status !== 200) {
        const failed = { status: 0, error: 'BENCH_CLIENT', message: `bench client answered ${response?.status ?? 'nothing'}` };
        return batch.writers.map(() => ({ repo: batch.repo, commit: failed, land: null }));
      }
      return (await response.json()).results.map((r) => ({ repo: batch.repo, ...r }));
    }),
  );
  return replies.flat();
}

const began = performance.now();
const writes = await fanout();
const elapsed = performance.now() - began;

const ok = (r) => r?.status === 200;
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
const landed = lands.filter(ok);
const first = Math.min(...landed.map((r) => r.started_at));
const last = Math.max(...landed.map((r) => r.started_at + r.ms));
const perRepo = repos.map((repo) => latency(writes.filter((w) => w.repo === repo.id && ok(w.land)).map((w) => w.land.ms)));

// One post-land check per repository on its main head (setup retries; the wait is measured).
const runner = { combined: { command: ['sh', '-c', 'test -f README.md'], timeout_seconds: 120 } };
const checks = await waves(repos, 25, async (repo) => {
  await api('PUT', `/repos/${repo.id}/policy`, { policy: { required_checks: [], approvals: 0, runners: runner } });
  const head = (await api('GET', `/repos/${repo.id}/refs`)).refs['refs/heads/main'];
  await api('POST', `/repos/${repo.id}/commits/${head}/check-runs`, { name: 'combined' });
  return { repo: repo.id, head };
});
const deadline = Date.now() + 10 * 60_000;
const finished = new Map();
while (finished.size < checks.length && Date.now() < deadline) {
  await waves(checks.filter((c) => !finished.has(c.repo)), 25, async (c) => {
    const shown = await api('GET', `/repos/${c.repo}/commits/${c.head}`).catch(() => null);
    const run = shown?.check_runs?.find((r) => r.name === 'combined');
    if (run && ['passed', 'failed', 'errored'].includes(run.status)) finished.set(c.repo, run);
  });
  if (finished.size < checks.length) await sleep(3000);
}
const runs = [...finished.values()];
const evidence = runs.map((r) => (typeof r.result === 'string' ? JSON.parse(r.result) : (r.result ?? {})));

const result = {
  repos: REPOS,
  writers_per_repo: WRITERS,
  elapsed_ms: Math.round(elapsed),
  commit: { client: latency(commits.filter(ok).map((r) => r.ms)), server: latency(commits.filter((r) => ok(r) && r.server !== null).map((r) => r.server)), ok: commits.filter(ok).length, errors: errors(commits) },
  land: {
    ok: landed.length,
    errors: errors(lands),
    per_second: Number(((landed.length * 1000) / Math.max(1, last - first)).toFixed(1)),
    client: latency(landed.map((r) => r.ms)),
    per_repo_p50: latency(perRepo.map((l) => l.p50_ms).filter((v) => v !== null)),
    per_repo_p95: latency(perRepo.map((l) => l.p95_ms).filter((v) => v !== null)),
  },
  overloaded: [...commits, ...lands].filter((r) => r && !ok(r) && /overloaded/i.test(r.message ?? '')).length,
  checks: {
    requested: checks.length,
    finished: runs.length,
    statuses: Object.entries(runs.reduce((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {})),
    queue_wait: latency(evidence.map((e) => e.queued_ms).filter(Number.isFinite)),
    cold_starts: evidence.filter((e) => Number.isFinite(e.start_ms)).length,
    cold_start: latency(evidence.map((e) => e.start_ms).filter(Number.isFinite)),
    duration: latency(evidence.map((e) => e.duration_ms).filter(Number.isFinite)),
  },
};
const report = {
  schema: 1,
  target: url,
  client: 'bench client Worker, aws:us-east-1',
  recorded_at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  result,
};
await mkdir(resolve(root, '.local/platform-live'), { recursive: true });
await writeFile(resolve(root, `.local/platform-live/manyrepo-${REPOS}x${WRITERS}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
