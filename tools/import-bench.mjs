#!/usr/bin/env node
// Bench of importing public repositories (`FAST_IMPORT`): docs/load-testing.md holds the
// budget. An explicit, separate command against a deployed platform: each run imports a
// repository under a new name, watches main appear and the store's main follow it, reads the
// Workflow's own timing (server-side) when it ends, and deletes the repository (--keep leaves
// it). Credentials come from YONEDA_USERNAME / YONEDA_PASSWORD. Evidence goes to
// .local/import-bench/<time>.json.
// Usage: node tools/import-bench.mjs --url https://<deployment> [--repos spf13/pflag,openai/whisper,spf13/cobra] [--runs 3] [--keep]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    repos: { type: 'string', default: 'spf13/pflag,openai/whisper,spf13/cobra' },
    runs: { type: 'string', default: '3' },
    keep: { type: 'boolean', default: false },
  },
});
assert.ok(values.url, 'Pass --url of the deployed platform');
const url = values.url.replace(/\/$/, '');
const RUNS = Number(values.runs);
const POLL_MS = 500;
const LIMIT_MS = 20 * 60 * 1000;

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.YONEDA_USERNAME, password: process.env.YONEDA_PASSWORD }),
});
assert.equal(login.status, 200, 'Login failed; set YONEDA_USERNAME and YONEDA_PASSWORD');
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

async function call(path, init = {}) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', cookie },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const seconds = (since) => Number(((performance.now() - since) / 1000).toFixed(1));

/** Whether the object store's own main is at `head`: what a clone through it would get. */
async function storeAt(repo, head) {
  const access = await call(`/repos/${repo}/clone`, { method: 'POST' });
  if (access.status !== 200) return false;
  const refs = await fetch(`${access.body.remote}/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${access.body.token}` },
  });
  return refs.ok && (await refs.text()).includes(`${head} refs/heads/main`);
}

async function run(source, n) {
  const name = `bench-${source.replace('/', '-')}-${Date.now()}-${n}`.slice(0, 100);
  const started = performance.now();
  const created = await call('/repos/import', {
    body: { url: `https://github.com/${source}.git`, name, visibility: 'private', max_commits: 5000 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const repo = created.body.id;
  const result = { source, repo };
  let head = null;
  let progress = 0;
  try {
    for (;;) {
      assert.ok(performance.now() - started < LIMIT_MS, 'The import ran past the bench limit');
      const status = await call(`/repos/${repo}`);
      head ??= status.body.refs?.find((r) => r.name === 'refs/heads/main')?.commit_id ?? null;
      if (head && !result.main_s) {
        result.main_s = seconds(started);
        const tree = await call(`/repos/${repo}/tree?ref=main`);
        assert.equal(tree.status, 200, 'Main landed but its files do not read');
        result.files_s = seconds(started);
      }
      if (head && !result.store_s && (await storeAt(repo, head))) result.store_s = seconds(started);
      const fill = status.body.history_import;
      if (fill) {
        assert.ok(fill.recorded >= progress, 'Progress went backwards');
        progress = fill.recorded;
        result.progress_seen = true;
      }
      const answer = await call(`/repos/${repo}/import`);
      if (answer.body.status === 'errored' || answer.body.status === 'terminated')
        throw new Error(`The import ${answer.body.status}: ${JSON.stringify(answer.body.error)}`);
      if (answer.body.status === 'complete') {
        result.total_s = seconds(started);
        result.commits = answer.body.output?.commits;
        result.timing = answer.body.output?.timing ?? null;
        break;
      }
      await wait(POLL_MS);
    }
    const log = await call(`/repos/${repo}/log?ref=main&limit=1`);
    assert.equal(log.body.history_import, undefined, 'A finished import still reads as partial');
  } finally {
    if (!values.keep) await call(`/repos/${repo}?confirm=${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
  return result;
}

const spread = (list) => {
  const sorted = list.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return sorted.length ? `${sorted[0]} / ${sorted[sorted.length >> 1]} / ${sorted.at(-1)}` : 'n/a';
};
const MEASURES = [
  ['Artifacts done, s (wall, client)', (r) => r.timing && r.timing.waited_ms / 1000],
  ['head landed after Artifacts, s (server)', (r) => r.timing && r.timing.head_ms / 1000],
  ['main visible, s (client, from request)', (r) => r.main_s],
  ['store main at head, s (client)', (r) => r.store_s],
  ['history, s (server)', (r) => r.timing && r.timing.history_ms / 1000],
  ['history, commits/s (server)', (r) => r.timing?.commits_per_s],
  ['wave median, commits/s (server)', (r) => r.timing?.wave_commits_per_s?.median],
  ['log, ms (server)', (r) => r.timing?.log_ms],
  ['trees, ms (server)', (r) => r.timing?.trees_ms],
  ['authority, ms (server)', (r) => r.timing?.authority_ms],
  ['whole import, s (client)', (r) => r.total_s],
];

const results = [];
for (const source of values.repos.split(',')) {
  const runs = [];
  for (let n = 1; n <= RUNS; n++) {
    const result = await run(source, n);
    console.log(`${source} run ${n}: ${JSON.stringify(result)}`);
    runs.push(result);
  }
  results.push(...runs);
  console.log(`\n${source}: ${runs[0].commits} commits, ${RUNS} runs (min / median / max)`);
  for (const [label, read] of MEASURES) console.log(`  ${label}: ${spread(runs.map(read))}`);
  if (!runs.every((r) => r.timing))
    console.log('  no server timing in the output: is FAST_IMPORT on for this Worker?');
}
await mkdir('.local/import-bench', { recursive: true });
const evidence = `.local/import-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(evidence, JSON.stringify(results, null, 2));
console.log(`\nEvidence: ${evidence}`);
