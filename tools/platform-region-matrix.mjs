#!/usr/bin/env node
// The same-region test (docs/global-scale-plan.md): a client Worker in North America, Europe and
// Asia, each on today's path (through the pinned Worker, data in enam) and on the region's (the
// platform's own routes running in that region, on an account and a repository whose objects
// started there), reporting what each operation still reached. Each client then times one call
// of each piece through a binding. Needs REGION_HINT_TEST=on on dev. Dev only; test repositories
// are deleted by their own path, and `--cleanup` deletes what a stopped run left. Evidence:
// .local/platform-live/, one file per run.
// `--probe-only` times the pieces again, with no repository and no switch needed.
// Usage: node tools/platform-region-matrix.mjs --dry-run | --yes | --results | --cleanup | --probe-only
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EVIDENCE_DIR, evidence, stampOf } from './fanout-bench/driver.mjs';
import { requireDev } from './fanout-bench/guard.mjs';
import { gitSession } from './fanout-bench/mac-git.mjs';
import { regionAccount } from './fanout-bench/region-accounts.mjs';
import { runArm } from './fanout-bench/region-matrix.mjs';
import { accountName, armsOf, DEFAULTS, describeMatrix, estimateMatrix, MIN_RUNS } from './fanout-bench/region-plan.mjs';
import { pieceTable, replicaTable, updateRegionResults } from './fanout-bench/region-results.mjs';
import { CLIENTS, placedClients, regionalClients } from './fanout-bench/regions.mjs';
import { OWN_TRAFFIC, readEnvFile, Session } from './staging/client.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    runs: { type: 'string', default: String(DEFAULTS.runs) },
    clients: { type: 'string', default: Object.keys(CLIENTS).join(',') },
    reads: { type: 'string', default: String(DEFAULTS.reads) },
    'no-mac-git': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    results: { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
    'probe-only': { type: 'boolean', default: false },
  },
});
const url = values.url.replace(/\/$/, '');
const origin = values.origin.replace(/\/$/, '');
requireDev([url, origin]);
const clients = values.clients.split(',');
assert.ok(clients.every((c) => CLIENTS[c]), `--clients is a list of ${Object.keys(CLIENTS)}`);
const options = { ...DEFAULTS, runs: Number(values.runs), reads: Number(values.reads) };

if (values.results) {
  console.error(`Results rebuilt from ${await updateRegionResults()} evidence files`);
  process.exit(0);
}
console.error(describeMatrix(estimateMatrix({ ...options, clients })));
if (options.runs < MIN_RUNS) console.error(`Fewer than ${MIN_RUNS} runs proves the tool works; it is not a result.`);
if (values['dry-run']) process.exit(0);
if (!values.yes && !values.cleanup && !values['probe-only']) {
  console.error('Nothing ran. Make sure nothing else runs on dev, then pass --yes.');
  process.exit(2);
}

const ledgerPath = resolve(EVIDENCE_DIR, 'region-hint-repos.json');
await mkdir(EVIDENCE_DIR, { recursive: true });
const held = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const saveLedger = () => writeFile(ledgerPath, `${JSON.stringify(held, null, 2)}\n`);
const kit = readEnvFile('staging-kit.env');
const { BENCH_KEY } = readEnvFile('staging-bench.env');
const { OWNER_TOKEN } = readEnvFile('staging.env', { required: false });
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
const operator = OWNER_TOKEN ? new Session(`${origin}/api/v1`, { bearer: OWNER_TOKEN }) : null;
const regional = regionalClients({ key: BENCH_KEY, target: url });
const front = regionalClients({ key: BENCH_KEY, target: origin });

const signedIn = new Map();
/** The account of a client's arm: its first sign-in makes it, in that arm's place. */
async function accountOf(client, { arm, serve }) {
  const key = `${client}-${arm}`;
  const signIn = async () => {
    const { session, row } = await regionAccount({ call: regional.call, client, serve, name: accountName(client, arm), kitPassword: kit.KIT_PASSWORD });
    signedIn.get(key).session = session;
    return { row };
  };
  if (!signedIn.has(key)) {
    signedIn.set(key, { signIn });
    await signIn();
  }
  return signedIn.get(key);
}

/** Deletes a test repository by its own path, as its owner, then ends its undo window; nothing
 * else is ever deleted here. */
async function remove({ id, name, client, arm }) {
  assert.ok(name.startsWith('region-hint-'), `${name} is not a test repository`);
  const { session } = await accountOf(client, armsOf(client).find((a) => a.arm === arm));
  const done = await session.raw('DELETE', `/api/v1/repos/${id}?confirm=${encodeURIComponent(name)}`);
  if (!done.ok) return void console.error(`${name} left: ${done.status} ${done.error ?? ''} (--cleanup tries again)`);
  const purged = await operator?.raw('POST', `/admin/repos/${id}/purge-now`, {});
  if (purged && !purged.ok) console.error(`${name} waits for its undo window: ${purged.status}`);
  held.splice(held.findIndex((r) => r.id === id), 1);
  await saveLedger();
}
if (values.cleanup) {
  // What a run that died before its ledger was written left: each test account's own list.
  for (const client of clients)
    for (const arm of armsOf(client)) {
      const { session } = await accountOf(client, arm);
      const { body } = await session.raw('GET', '/api/v1/repos');
      for (const { id, name } of body.repos ?? [])
        if (/^region-hint-(?!sim-)/.test(name) && !held.some((r) => r.id === id)) held.push({ id, name, client, arm: arm.arm });
    }
  for (const repo of [...held]) await remove(repo);
  console.error(`${held.length} test repositories left`);
  process.exit(held.length ? 3 : 0);
}

if (values['probe-only']) {
  const placed = await placedClients(regional, clients);
  const probes = await Promise.all(
    clients.map(async (client) => {
      const { session } = await accountOf(client, armsOf(client)[1]);
      return { client, run: 1, ...(await regional.call(client, { probe: { samples: 20, account: session.name, repos: [] } })) };
    }),
  );
  const record = await evidence('region-probe', url, { runs: 0, clients: placed, arms: [], probes, mac_git: [] }, { client: `regional clients: ${clients.join(', ')}`, quiet: true });
  // Printed, not written: the doc's tables are rebuilt from every evidence file, and evidence dies
  // with its worktree, so a rebuild here could leave a run's tables with nothing behind them.
  console.log(`${pieceTable([record])}\n\n${replicaTable([record])}`);
  process.exit(0);
}

const stamp = stampOf(new Date()).slice(5, 19).toLowerCase().replace(/[^0-9t]/g, '');
const placed = await placedClients(regional, clients);
console.error(`Clients: ${JSON.stringify(placed)}`);
const html = await (await fetch(`${origin}/`, { headers: { ...OWN_TRAFFIC } })).text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);

/** A personal token for this run, by the arm's own account and path. */
async function patOf(account) {
  const made = await account.session.post('/api/v1/tokens', { name: `region-${stamp}`, scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:admin'], expires_days: 1 });
  return made;
}

const arms = [];
const probes = [];
const mac_git = [];
const tokens = [];
let stop = null;
const realGit = async (arm, account) => {
  const { token } = await account.session.post(`/api/v1/repos/${arm.id}/tokens`, { name: 'matrix-mac', scopes: ['read', 'write', 'land'] });
  const session = gitSession(token, url);
  try {
    for (let i = 0; i < options.clones; i++) {
      const clone = await session.git(['clone', '-q', `${url}/git/${arm.id}.git`, `c${i}`]);
      mac_git.push({ op: 'clone', run: arm.run, ok: clone.ok, ms: clone.ms, ...(clone.ok ? {} : { tail: clone.tail }) });
    }
    for (let i = 0; i < options.pushes; i++) {
      const cwd = `${session.dir}/c0`;
      await session.git(['commit', '-q', '--allow-empty', '-m', `mac ${i}`], cwd);
      const push = await session.git(['push', '-q', 'origin', `HEAD:refs/heads/mac/${i}`], cwd);
      mac_git.push({ op: 'push', run: arm.run, ok: push.ok, ms: push.ms, ...(push.ok ? {} : { tail: push.tail }) });
    }
  } finally {
    session.close();
  }
};
const ledger = (client, arm) => ({
  add: async ({ id, name }) => {
    held.push({ id, name, client, arm });
    await saveLedger();
  },
});
try {
  for (let run = 1; run <= options.runs && !stop; run++) {
    const made = [];
    for (const which of [0, 1]) {
      if (stop) break;
      // One region's arm doesn't touch another's, so they run side by side.
      const group = await Promise.all(
        clients.map(async (client) => {
          const arm = armsOf(client)[which];
          const account = await accountOf(client, arm);
          const token = await patOf(account);
          tokens.push({ account, id: token.id });
          return { outcome: await runArm({ call: regional.call, front: front.call, account, pat: token.token, ledger: ledger(client, arm.arm), assets }, { stamp, run, client, arm, options }), account };
        }),
      );
      arms.push(...group.map((g) => g.outcome));
      made.push(...group.filter((g) => g.outcome.id).map((g) => g.outcome));
      stop = group.find((g) => g.outcome.stop)?.outcome.stop ?? null;
      for (const { outcome: a } of group) console.error(`run ${run} ${a.client} ${a.arm}: ${a.failed ?? a.stop ?? `code in ${a.where?.worker}, authority ${a.where?.authority}, ${Object.values(a.ops).flat().filter((r) => !r.ok).length} failed`}`);
      const today = group.find((g) => g.outcome.client === 'na' && g.outcome.arm === 'today');
      if (!values['no-mac-git'] && today?.outcome.id && !stop) await realGit(today.outcome, today.account);
    }
    if (!stop) {
      const answers = await Promise.all(
        clients.map(async (client) => {
          const near = CLIENTS[client].near;
          const repos = made.filter((a) => a.client === client).map((a) => ({ data: a.arm === 'today' ? 'enam_today' : near, id: a.id }));
          const account = signedIn.get(`${client}-region`).session.name;
          return { client, run, ...(await regional.call(client, { probe: { samples: options.samples, account, repos, serve: near } })) };
        }),
      );
      probes.push(...answers);
      for (const a of answers) if (a.failed) console.error(`probe ${a.client}: ${a.failed}`);
    }
    for (const arm of made) await remove({ id: arm.id, name: arm.name, client: arm.client, arm: arm.arm });
  }
} finally {
  for (const { account, id } of tokens) await account.session.raw('DELETE', `/api/v1/tokens/${id}`).catch(() => {});
  if (held.length) console.error(`${held.length} test repositories left: node tools/platform-region-matrix.mjs --cleanup`);
}
if (stop) {
  console.error(`Stopped: ${stop}`);
  process.exit(3);
}
const result = { runs: options.runs, options, clients: placed, arms, probes, mac_git };
await evidence('region-matrix', url, result, { client: `regional clients: ${clients.join(', ')}`, quiet: true });
console.error(`Results rebuilt from ${await updateRegionResults()} evidence files`);
