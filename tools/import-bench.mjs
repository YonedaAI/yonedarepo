#!/usr/bin/env node
// Bench of importing public repositories (`FAST_IMPORT`, and `DIRECT_IMPORT` when it is on):
// docs/load-testing.md and docs/direct-import.md hold the budgets. The bar is a `git clone`: each repository is first cloned from GitHub, as stock Git
// does, then imported under a new name. A run times the request to main usable (files read,
// the server's own stages from the Workflow's timing), a real `git clone` of ours started
// that moment (checked against the commit count and with `git fsck`), and history's fill. It
// deletes its repository unless --keep. Credentials come from the environment
// (YONEDA_USERNAME / YONEDA_PASSWORD, or DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD); a token
// reaches Git through the environment only. Evidence: .local/import-bench/<time>.json.
// Usage: node tools/import-bench.mjs --url https://<platform host> [--git https://<Git host>]
//   [--repos spf13/pflag,openai/whisper,spf13/cobra] [--runs 3] [--keep]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    git: { type: 'string' },
    repos: { type: 'string', default: 'spf13/pflag,openai/whisper,spf13/cobra' },
    runs: { type: 'string', default: '3' },
    keep: { type: 'boolean', default: false },
  },
});
assert.ok(values.url, 'Pass --url of the deployed platform');
const url = values.url.replace(/\/$/, '');
const gitHost = (values.git ?? url).replace(/\/$/, '');
const RUNS = Number(values.runs);
const POLL_MS = 500;
const LIMIT_MS = 20 * 60 * 1000;

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.YONEDA_USERNAME ?? process.env.DEV_OWNER_USERNAME,
    password: process.env.YONEDA_PASSWORD ?? process.env.DEV_OWNER_PASSWORD,
  }),
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

/** Runs Git, nothing of the user's configuration or credentials involved. */
function git(args, env = {}) {
  return new Promise((done, failed) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString().trim();
      if (code === 0) done(text);
      else failed(new Error(`git ${args[0]}: ${text.slice(-300)}`));
    });
  });
}

/** Seconds a whole `git clone` of `remote` takes, and what it holds. */
async function timedClone(remote, env, options = []) {
  const dir = await mkdtemp(join(tmpdir(), 'import-bench-'));
  const started = performance.now();
  try {
    await git(['clone', '-q', ...options, remote, join(dir, 'r')], env);
    const clone_s = seconds(started);
    const head = await git(['-C', join(dir, 'r'), 'rev-parse', 'HEAD']);
    const commits = Number(await git(['-C', join(dir, 'r'), 'rev-list', '--first-parent', '--count', 'HEAD']));
    await git(['-C', join(dir, 'r'), 'fsck', '--connectivity-only']);
    return { clone_s, head, commits };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A clone of ours through the repository's Git address, with a read token. */
async function ownClone(repo) {
  const minted = await call(`/repos/${repo}/tokens`, { body: { name: 'import-bench', scopes: ['read'] } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  const remote = `${gitHost}/git/${repo}.git`;
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${minted.body.token}`,
  };
  const [whole, shallow] = await Promise.all([timedClone(remote, env), timedClone(remote, env, ['--depth', '1'])]);
  assert.equal(shallow.commits, 1, 'A clone of depth 1 is not shallow');
  return { ...whole, depth_clone_s: shallow.clone_s };
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
  let clone = null;
  try {
    for (;;) {
      assert.ok(performance.now() - started < LIMIT_MS, 'The import ran past the bench limit');
      const status = await call(`/repos/${repo}`);
      head ??= status.body.refs?.find((r) => r.name === 'refs/heads/main')?.commit_id ?? null;
      if (head && !result.usable_s) {
        const tree = await call(`/repos/${repo}/tree?ref=main`);
        assert.equal(tree.status, 200, 'Main landed but its files do not read');
        result.usable_s = seconds(started);
        result.filling_at_usable = status.body.history_import ?? null;
        // Started the moment it should work, whatever history is doing.
        clone = ownClone(repo);
        clone.catch(() => {});
      }
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
        result.imported = answer.body.output?.commits;
        result.timing = answer.body.output?.timing ?? null;
        result.stopped = answer.body.output?.stopped;
        break;
      }
      await wait(POLL_MS);
    }
    const log = await call(`/repos/${repo}/log?ref=main&limit=1`);
    assert.equal(log.body.history_import, undefined, 'A finished import still reads as partial');
    Object.assign(result, await clone);
    assert.equal(result.head, head, 'Our clone is not at main');
    // What the Workflow says it recorded, then what the clone holds: on a history that
    // ended early (`stopped`), the clone has it all and the log the part recorded.
    assert.equal(result.stopped, undefined, `History ended early: ${JSON.stringify(result.stopped)}`);
    assert.equal(result.imported, result.commits, 'Recorded commits differ from the clone\'s');
  } finally {
    if (!values.keep) await call(`/repos/${repo}?confirm=${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
  return result;
}

const spread = (list) => {
  const sorted = list.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return sorted.length ? `${sorted[0]} / ${sorted[sorted.length >> 1]} / ${sorted.at(-1)}` : 'n/a';
};
const server = (key) => (r) => (r.timing ? r.timing[key] / 1000 : undefined);
const MEASURES = [
  ['usable: request to files read, s (client)', (r) => r.usable_s],
  ['  request to Artifacts asked, s (server)', server('start_ms')],
  ['  Artifacts fetching the remote, s (server)', server('artifacts_ms')],
  ['  direct: GitHub naming its head, s (server)', server('remote_ms')],
  ['  direct: the pack arriving and read, s (server)', server('pack_ms')],
  ['  direct: the chain listed, s (server)', server('read_ms')],
  ['  direct: head and pack stored, s (server)', server('store_ms')],
  ['  reading the log, s (server)', server('chain_ms')],
  ['  landing the head, s (server)', server('land_ms')],
  ['our git clone, s (client)', (r) => r.clone_s],
  ['our git clone --depth 1, s (client)', (r) => r.depth_clone_s],
  ['history, s (server)', server('history_ms')],
  ['history, commits/s (server)', (r) => r.timing?.commits_per_s],
  ['  log, s (server)', server('log_ms')],
  ['  trees, s (server)', server('trees_ms')],
  ['  authority, s (server)', server('authority_ms')],
];

const results = [];
for (const source of values.repos.split(',')) {
  const baseline = [];
  for (let n = 1; n <= RUNS; n++) baseline.push(await timedClone(`https://github.com/${source}.git`));
  const runs = [];
  for (let n = 1; n <= RUNS; n++) {
    const result = await run(source, n);
    console.log(`${source} run ${n}: ${JSON.stringify(result)}`);
    runs.push(result);
  }
  results.push({ source, baseline, runs });
  console.log(`\n${source}: ${runs[0].imported} commits, ${RUNS} runs (min / median / max)`);
  console.log(`  landed by: ${runs.map((r) => r.timing?.landed_by ?? 'unknown').join(', ')}`);
  console.log(`  git clone from GitHub, s (client): ${spread(baseline.map((b) => b.clone_s))}`);
  for (const [label, read] of MEASURES) console.log(`  ${label}: ${spread(runs.map(read))}`);
  if (!runs.every((r) => r.timing?.usable_ms !== undefined))
    console.log('  no server timing in the output: is FAST_IMPORT on for this Worker?');
}
await mkdir('.local/import-bench', { recursive: true });
const evidence = `.local/import-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(evidence, JSON.stringify(results, null, 2));
console.log(`\nEvidence: ${evidence}`);
