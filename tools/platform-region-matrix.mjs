#!/usr/bin/env node
// The latency matrix: client region × data region (docs/global-scale-plan.md). A client Worker in
// North America, Europe and Asia each works on a fresh repository whose Durable Objects started
// in enam, weur or apac, through the pinned platform Worker. Each client then times one read of
// each piece through a binding, which is what moving that piece near it would change. Needs
// REGION_HINT_TEST=on on dev. Dev only; test repositories are deleted by their own path, and
// `--cleanup` deletes what a stopped run left. Evidence: .local/platform-live/, one file per run.
// Usage: node tools/platform-region-matrix.mjs --dry-run | --yes | --results | --cleanup
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EVIDENCE_DIR, evidence, stampOf } from './fanout-bench/driver.mjs';
import { requireDev } from './fanout-bench/guard.mjs';
import { gitSession } from './fanout-bench/mac-git.mjs';
import { runPair } from './fanout-bench/region-matrix.mjs';
import { DEFAULTS, describeMatrix, estimateMatrix, MIN_RUNS } from './fanout-bench/region-plan.mjs';
import { updateRegionResults } from './fanout-bench/region-results.mjs';
import { CLIENTS, DATA_REGIONS, placedClients, regionalClients } from './fanout-bench/regions.mjs';
import { accountSession, purgeWhatIsDeleted, readEnvFile, Session } from './staging/client.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    runs: { type: 'string', default: String(DEFAULTS.runs) },
    clients: { type: 'string', default: Object.keys(CLIENTS).join(',') },
    data: { type: 'string', default: DATA_REGIONS.join(',') },
    reads: { type: 'string', default: String(DEFAULTS.reads) },
    'no-mac-git': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    results: { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
  },
});
const url = values.url.replace(/\/$/, '');
const origin = values.origin.replace(/\/$/, '');
requireDev([url, origin]);
const clients = values.clients.split(',');
const data = values.data.split(',');
assert.ok(clients.every((c) => CLIENTS[c]), `--clients is a list of ${Object.keys(CLIENTS)}`);
assert.ok(data.every((d) => DATA_REGIONS.includes(d)), `--data is a list of ${DATA_REGIONS}`);
const options = { ...DEFAULTS, runs: Number(values.runs), reads: Number(values.reads) };

if (values.results) {
  console.error(`Results rebuilt from ${await updateRegionResults()} evidence files`);
  process.exit(0);
}
console.error(describeMatrix(estimateMatrix({ ...options, clients, data })));
if (options.runs < MIN_RUNS) console.error(`Fewer than ${MIN_RUNS} runs proves the tool works; it is not a result.`);
if (values['dry-run']) process.exit(0);
if (!values.yes && !values.cleanup) {
  console.error('Nothing ran. Make sure nothing else runs on dev, then pass --yes.');
  process.exit(2);
}

const ledgerPath = resolve(EVIDENCE_DIR, 'region-hint-repos.json');
const held = JSON.parse(await readFile(ledgerPath, 'utf8').catch(() => '[]'));
const ledger = {
  add: async (repo) => {
    held.push(repo);
    await writeFile(ledgerPath, `${JSON.stringify(held, null, 2)}\n`);
  },
  drop: async (id) => {
    held.splice(held.findIndex((r) => r.id === id), 1);
    await writeFile(ledgerPath, `${JSON.stringify(held, null, 2)}\n`);
  },
};

const kit = readEnvFile('staging-kit.env');
const { BENCH_KEY } = readEnvFile('staging-bench.env');
const { OWNER_TOKEN } = readEnvFile('staging.env', { required: false });
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
if (OWNER_TOKEN) purgeWhatIsDeleted(new Session(`${origin}/api/v1`, { bearer: OWNER_TOKEN }));
const { cookie, name: who } = await accountSession(origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
const account = new Session(`${origin}/api/v1`, { cookie });

/** Deletes a test repository by its own path; nothing else is ever deleted here. */
async function remove({ id, name }) {
  assert.ok(name.startsWith('region-hint-'), `${name} is not a test repository`);
  const done = await account.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`).catch((e) => ({ ok: false, status: e.message }));
  if (done.ok) await ledger.drop(id);
  else console.error(`${name} left: ${done.status} (--cleanup tries again)`);
}
if (values.cleanup) {
  for (const repo of [...held]) await remove(repo);
  console.error(`${held.length} test repositories left`);
  process.exit(held.length ? 3 : 0);
}

const stamp = stampOf(new Date()).slice(5, 19).toLowerCase().replace(/[^0-9t]/g, '');
const regional = regionalClients({ key: BENCH_KEY, target: url });
const placed = await placedClients(regional, clients);
console.error(`Clients: ${JSON.stringify(placed)}`);
const { id: patId, token: pat } = await account.post('/tokens', { name: `region-matrix-${stamp}`, scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:admin'], expires_days: 1 });

const pairs = [];
const probes = [];
const mac_git = [];
let stop = null;
const realGit = async (pair) => {
  const token = (await account.post(`/repos/${pair.id}/tokens`, { name: 'matrix-mac', scopes: ['read', 'write', 'land'] })).token;
  const session = gitSession(token, url);
  try {
    for (let i = 0; i < options.clones; i++) {
      const clone = await session.git(['clone', '-q', `${url}/git/${pair.id}.git`, `c${i}`]);
      mac_git.push({ data: pair.data, op: 'clone', run: pair.run, ok: clone.ok, ms: clone.ms, ...(clone.ok ? {} : { tail: clone.tail }) });
    }
    for (let i = 0; i < options.pushes; i++) {
      const cwd = `${session.dir}/c0`;
      await session.git(['commit', '-q', '--allow-empty', '-m', `mac ${i}`], cwd);
      const push = await session.git(['push', '-q', 'origin', `HEAD:refs/heads/mac/${i}`], cwd);
      mac_git.push({ data: pair.data, op: 'push', run: pair.run, ok: push.ok, ms: push.ms, ...(push.ok ? {} : { tail: push.tail }) });
    }
  } finally {
    session.close();
  }
};
try {
  for (let run = 1; run <= options.runs && !stop; run++) {
    const made = [];
    for (const region of data) {
      if (stop) break;
      // A client's pairs don't touch each other, so the three run side by side.
      const group = await Promise.all(clients.map((client) => runPair({ call: regional.call, pat, ledger }, { stamp, run, client, data: region, options })));
      pairs.push(...group);
      made.push(...group.filter((p) => p.id));
      stop = group.find((p) => p.stop)?.stop ?? null;
      for (const p of group) console.error(`run ${run} ${p.client}->${p.data}: ${p.failed ?? p.stop ?? `authority ${p.where?.authority}, ${Object.values(p.ops).flat().filter((r) => !r.ok).length} failed`}`);
      if (!values['no-mac-git'] && group[0]?.id && !stop) await realGit(group[0]);
    }
    if (!stop) {
      const repos = data.map((region) => ({ data: region, id: made.find((p) => p.data === region)?.id })).filter((r) => r.id);
      const answers = await Promise.all(clients.map(async (client) => ({ client, run, ...(await regional.call(client, { probe: { samples: options.samples, account: who, repos } })) })));
      probes.push(...answers);
      for (const a of answers) if (a.failed) console.error(`probe ${a.client}: ${a.failed}`);
    }
    for (const repo of made) await remove(repo);
  }
} finally {
  await account.raw('DELETE', `/tokens/${patId}`).catch(() => {});
  if (held.length) console.error(`${held.length} test repositories left: node tools/platform-region-matrix.mjs --cleanup`);
}
if (stop) {
  console.error(`Stopped: ${stop}`);
  process.exit(3);
}
const result = { runs: options.runs, options, clients: placed, pairs, probes, mac_git };
await evidence('region-matrix', url, result, { client: `regional clients: ${clients.join(', ')}`, quiet: true });
console.error(`Results rebuilt from ${await updateRegionResults()} evidence files`);
