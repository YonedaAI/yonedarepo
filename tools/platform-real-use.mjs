#!/usr/bin/env node
// One day of real use on dev, in an hour (docs/load-testing.md, Real-use simulation): accounts and
// repositories in three regions, sessions of people and agents at their own pace, each sent from a
// client Worker in its region. On the `region` arm, the default, each region's data lives there
// and the platform's routes run there, so requests stay in the region as far as today's stack
// can. `--arm today` plays the same day through the pinned Worker, for comparing. Real Git runs
// from this machine. `--dry-run` prints the plan and sends nothing. Accounts and repositories are
// kept for the next run; tokens are not. Dev only; the region arm needs REGION_HINT_TEST=on.
// Usage: node tools/platform-real-use.mjs --dry-run | --yes [--arm region|today] [--minutes 60]
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cloudflareReaders } from './fanout-bench/cf-analytics.mjs';
import { EVIDENCE_DIR, evidence, stampOf } from './fanout-bench/driver.mjs';
import { devSpec, requireDev } from './fanout-bench/guard.mjs';
import { placedClients, regionalClients } from './fanout-bench/regions.mjs';
import { startSampler } from './fanout-bench/sampler.mjs';
import { OWN_TRAFFIC, readEnvFile } from './staging/client.mjs';
import { describeRun, estimateRun } from './real-use/estimate.mjs';
import { macGitLoop } from './real-use/mac-loop.mjs';
import { ARMS, DEFAULTS, ZONES } from './real-use/plan.mjs';
import { mintCredentials, populationOf, preparePool } from './real-use/population.mjs';
import { playDay } from './real-use/run.mjs';
import { renderSummary, summarize } from './real-use/summary.mjs';

const { values } = parseArgs({
  options: {
    arm: { type: 'string', default: DEFAULTS.arm },
    api: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    front: { type: 'string', default: 'https://dev.yonedarepo.com' },
    minutes: { type: 'string', default: String(DEFAULTS.minutes) },
    'peak-sessions': { type: 'string', default: String(DEFAULTS.peakSessions) },
    accounts: { type: 'string', default: String(DEFAULTS.accounts) },
    'repos-per-account': { type: 'string', default: String(DEFAULTS.reposPerAccount) },
    seed: { type: 'string', default: String(DEFAULTS.seed) },
    'git-every': { type: 'string', default: String(DEFAULTS.gitEvery) },
    'sample-seconds': { type: 'string', default: String(DEFAULTS.sampleSeconds) },
    'start-utc': { type: 'string', default: String(DEFAULTS.startUtc) },
    'setup-only': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
const api = values.api.replace(/\/$/, '');
const front = values.front.replace(/\/$/, '');
requireDev([api, front]);
assert.ok(ARMS.includes(values.arm), `--arm is one of ${ARMS}`);
const plan = await estimateRun({
  arm: values.arm,
  minutes: Number(values.minutes),
  peakSessions: Number(values['peak-sessions']),
  accounts: Number(values.accounts),
  reposPerAccount: Number(values['repos-per-account']),
  seed: Number(values.seed),
  gitEvery: Number(values['git-every']),
  sampleSeconds: Number(values['sample-seconds']),
  startUtc: Number(values['start-utc']),
});
plan.maxSessions = plan.peakSessions * 4;
console.error(describeRun(plan));
if (values['dry-run']) process.exit(0);
if (!values.yes && !values['setup-only']) {
  console.error('Nothing ran. Warn the owner, make sure nothing else runs on dev and no deploy can happen, then pass --yes.');
  process.exit(2);
}

const lock = resolve(EVIDENCE_DIR, 'real-use.lock');
await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(lock, String(process.pid), { flag: 'wx' }).catch(() => {
  throw new Error(`${lock} exists: another run is going, or a stopped one left it`);
});
const log = (text) => console.error(text);
const kit = readEnvFile('staging-kit.env');
const { BENCH_KEY } = readEnvFile('staging-bench.env');
const { CF_ANALYTICS_TOKEN } = readEnvFile('staging.env', { required: false });
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let credentials = null;
try {
  const regions = Object.keys(ZONES);
  const clients = { [api]: regionalClients({ key: BENCH_KEY, target: api }), [front]: regionalClients({ key: BENCH_KEY, target: front }) };
  const placed = await placedClients(clients[api], regions);
  log(`Clients: ${JSON.stringify(placed)}`);
  const { pool, sessions } = await preparePool({ arm: plan.arm, target: api, call: clients[api].call, kitPassword: kit.KIT_PASSWORD, accounts: plan.accounts, reposPerAccount: plan.reposPerAccount, files: plan.files, regions, log });
  if (values['setup-only']) process.exit(0);
  const html = await (await fetch(`${front}/`, { headers: { ...OWN_TRAFFIC } })).text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))].slice(0, 2);
  const repos = pool.repos.filter((r) => r.owner < plan.accounts);
  const run = stampOf(new Date()).slice(0, 19).toLowerCase().replace(/[^0-9t]/g, '');
  credentials = await mintCredentials({ sessions, run, repos });
  const population = populationOf({ arm: plan.arm, pool, sessions, credentials, repos, api, front, regions });
  const rowsFile = createWriteStream(resolve(EVIDENCE_DIR, `real-use-${run}.rows.jsonl`));
  const owners = new Map(repos.map((r) => [r.id, sessions[r.owner]]));
  const sampler = startSampler({
    session: { call: (method, path) => owners.get(/r[0-9a-f]{20}/.exec(path)?.[0]).raw(method, `/api/v1${path}`).then((a) => ({ status: a.status, body: a.body })) },
    repos: repos.map((r) => r.id),
    analytics: CF_ANALYTICS_TOKEN ? cloudflareReaders({ token: CF_ANALYTICS_TOKEN, spec: devSpec() }) : null,
    every_ms: plan.sampleSeconds * 1000,
    log,
  });
  const nearPublic = repos.map((repo, i) => ({ repo, token: credentials.tokens[i] })).filter(({ repo }) => plan.arm === 'today' || pool.accounts[repo.owner].client === 'na');
  const day = await playDay({
    plan,
    population,
    assets,
    log,
    signal: controller.signal,
    send: (region, target, steps, parallel, serve) => clients[target].call(region, { steps, parallel, ...(serve && { serve }) }),
    onRow: (row) => rowsFile.write(`${JSON.stringify(row)}\n`),
    // Git reaches only the public path, so only repositories that path is near.
    sideJobs: [macGitLoop({ api, repos: nearPublic.map((r) => r.repo), tokens: nearPublic.map((r) => r.token), every_s: plan.gitEvery, random: Math.random })],
  });
  rowsFile.end();
  const server = await sampler.stop({ settle_ms: 30_000 });
  const summary = summarize(day, { plan, placed, sampler: server.summary });
  await evidence(`real-use-${plan.arm}-${plan.minutes}m`, api, { summary }, { client: 'regional clients and real Git from the Mac', quiet: true });
  console.log(renderSummary(summary));
  log(`Stopped: ${day.stopped}. ${summary.all.requests} requests, ${summary.all.failed} failed, ${summary.all.conflicts} conflicts, ${day.counts.dropped} sessions dropped.`);
  process.exitCode = day.stopped === 'finished' ? 0 : 3;
} finally {
  const left = credentials ? await credentials.revoke() : 0;
  if (left) console.error(`${left} credentials not revoked; they expire within a day`);
  await rm(lock, { force: true });
}
