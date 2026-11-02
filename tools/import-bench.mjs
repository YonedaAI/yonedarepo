#!/usr/bin/env node
// Bench of importing public repositories: docs/clone-import.md holds the budget. The bar is a
// `git clone`: each repository is first cloned from GitHub, as stock Git does, then imported
// under a new name. An import lands its refs last, so a run watches `GET /repos/<id>/import` to
// `complete`, then reads the refs and files and starts a real `git clone` of ours (checked
// against the commit count and with `git fsck`). It deletes its repository unless --keep. It
// times what the client waits for: the import's answer, the import done and the first read, each
// with its Server-Timing. The import's output holds counts, no stages. Credentials come from the
// environment (YONEDA_USERNAME / YONEDA_PASSWORD, or DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD); a
// token reaches Git through the environment only. Evidence: .local/import-bench/<time>.json.
// Usage: node tools/import-bench.mjs --url https://<platform host> [--git https://<Git host>]
//   [--repos spf13/pflag,openai/whisper,spf13/cobra] [--runs 3] [--keep]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gitConfigEnv, OWN_TRAFFIC } from './own-traffic.mjs';

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
/** A `git clone` may take its 60 minutes, and the steps behind it their own. */
const LIMIT_MS = 2 * 60 * 60 * 1000;

const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...OWN_TRAFFIC },
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
    headers: { 'content-type': 'application/json', ...OWN_TRAFFIC, cookie },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    timing: response.headers.get('server-timing'),
  };
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
    const commits = Number(await git(['-C', join(dir, 'r'), 'rev-list', '--count', '--all']));
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
    ...gitConfigEnv({ token: minted.body.token }),
  };
  const named = (what, clone) =>
    clone.catch((e) => {
      throw new Error(`${what}: ${e.message}`);
    });
  const [whole, shallow] = await Promise.all([
    named('whole clone', timedClone(remote, env)),
    named('clone of depth 1', timedClone(remote, env, ['--depth', '1'])),
  ]);
  assert.equal(shallow.commits, 1, 'A clone of depth 1 is not shallow');
  return { ...whole, depth_clone_s: shallow.clone_s };
}

async function run(source, n) {
  const name = `bench-${source.replace('/', '-')}-${Date.now()}-${n}`.slice(0, 100);
  const started = performance.now();
  const created = await call('/repos/import', {
    body: { url: `https://github.com/${source}.git`, name, visibility: 'private' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const repo = created.body.id;
  const result = { source, repo, answer_s: seconds(started), answer_timing: created.timing };
  try {
    for (;;) {
      assert.ok(performance.now() - started < LIMIT_MS, 'The import ran past the bench limit');
      const looking = performance.now();
      const answer = await call(`/repos/${repo}/import`);
      result.import_look_s = Math.max(result.import_look_s ?? 0, seconds(looking));
      if (answer.body.status === 'errored' || answer.body.status === 'terminated')
        throw new Error(`The import ${answer.body.status}: ${JSON.stringify(answer.body.error)}`);
      if (answer.body.status === 'complete') {
        result.complete_s = seconds(started);
        const { commit, commits, objects, refs, left_out, pack_bytes } = answer.body.output ?? {};
        Object.assign(result, { imported: commits, objects, refs_imported: refs, left_out, pack_bytes, landed: commit });
        break;
      }
      await wait(POLL_MS);
    }
    const status = await call(`/repos/${repo}`);
    const main = status.body.refs?.find((r) => r.name === 'refs/heads/main')?.commit_id;
    assert.equal(main, result.landed, 'Main is not the commit the import landed');
    result.refs = status.body.refs.length;
    assert.equal(result.refs + result.left_out, result.refs_imported, 'Refs differ from what the import made');
    const reading = performance.now();
    const tree = await call(`/repos/${repo}/tree?ref=main`);
    assert.equal(tree.status, 200, 'Main landed but its files do not read');
    result.usable_s = seconds(started);
    result.read_s = seconds(reading);
    result.read_timing = tree.timing;
    Object.assign(result, await ownClone(repo));
    assert.equal(result.head, main, 'Our clone is not at main');
    // A ref left out takes the commits only it reaches with it.
    if (!result.left_out) assert.equal(result.imported, result.commits, "Recorded commits differ from the clone's");
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
  ['usable: request to files read, s (client)', (r) => r.usable_s],
  ['  the import request answered, s (client)', (r) => r.answer_s],
  ['  the import complete, s (client)', (r) => r.complete_s],
  ['  the first read of files, s (client)', (r) => r.read_s],
  ['  slowest look at the import, s (client)', (r) => r.import_look_s],
  ['our git clone, s (client)', (r) => r.clone_s],
  ['our git clone --depth 1, s (client)', (r) => r.depth_clone_s],
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
  const { imported, objects, refs, pack_bytes } = runs[0];
  console.log(`\n${source}: ${imported} commits, ${objects} objects, ${refs} refs, ${pack_bytes} pack bytes, ${RUNS} runs (min / median / max)`);
  console.log(`  git clone from GitHub, s (client): ${spread(baseline.map((b) => b.clone_s))}`);
  for (const [label, read] of MEASURES) console.log(`  ${label}: ${spread(runs.map(read))}`);
}
await mkdir('.local/import-bench', { recursive: true });
const evidence = `.local/import-bench/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(evidence, JSON.stringify(results, null, 2));
console.log(`\nEvidence: ${evidence}`);
