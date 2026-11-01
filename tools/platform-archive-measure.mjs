#!/usr/bin/env node
// Archive stage A's measurement (docs/load-testing.md): the same work on a real-history import,
// with the four switches off and then on, reporting bytes per item and server time. `--baseline`
// reads the owner's dev test repositories and writes nothing; those are never written, forked or
// re-imported here. Dev only. Evidence and the saved repository list: the repository root's
// .local/scale-next/. Credentials from ~/.config/yonedarepo, never printed.
// Usage: node tools/platform-archive-measure.mjs --dry-run
//        node tools/platform-archive-measure.mjs --baseline
//        node tools/platform-archive-measure.mjs --arm off|on --yes [--runs 3]
//        node tools/platform-archive-measure.mjs --results
//        node tools/platform-archive-measure.mjs --cleanup --yes   deletes this tool's imports
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ARMS, DEFAULTS, describe, DEV_JSON_CHANGE, estimate, MIN_RUNS, PROTECTED, repoName, requireArm, requireMeasured } from './archive-measure/plan.mjs';
import { updateArchive } from './archive-measure/report.mjs';
import { baseline, importArm, measureRun } from './archive-measure/run.mjs';
import { connect, evidence, rootLocal, stampOf } from './fanout-bench/driver.mjs';
import { devSpec, requireDev } from './fanout-bench/guard.mjs';
import { accountSession, purgeWhatIsDeleted, readEnvFile, Session } from './staging/client.mjs';

const spec = devSpec();
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    client: { type: 'string', default: `https://${spec.prefix}-bench.${spec.subdomain}.workers.dev` },
    arm: { type: 'string' },
    runs: { type: 'string', default: String(DEFAULTS.runs) },
    'dry-run': { type: 'boolean', default: false },
    baseline: { type: 'boolean', default: false },
    results: { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});
const dir = rootLocal('scale-next');
if (values.results) {
  console.error(`Results rebuilt from ${await updateArchive(dir)} runs`);
  process.exit(0);
}
const url = values.url.replace(/\/$/, '');
requireDev([url, values.client]);
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs > 0, '--runs is a whole number');
const plan = estimate({ runs });
console.error(describe(plan));
console.error(`The on arm's switches, in the platform Worker's vars in infra/envs/dev.json:\n${DEV_JSON_CHANGE}`);
if (values['dry-run']) process.exit(0);

const poolFile = resolve(dir, 'archive-repositories.json');
const saved = JSON.parse(await readFile(poolFile, 'utf8').catch(() => '{}'));
const save = async () => {
  await mkdir(dir, { recursive: true });
  await writeFile(poolFile, `${JSON.stringify(saved, null, 2)}\n`);
};
const signIn = (username, password) => accountSession(url, username, password);

if (values.baseline) {
  const owner = readEnvFile('dev-owner.env');
  const api = await signIn(owner.DEV_OWNER_USERNAME, owner.DEV_OWNER_PASSWORD);
  const listed = await api.raw('GET', '/api/v1/repos');
  assert.ok(listed.ok, `GET /repos: ${listed.status}`);
  const repositories = await baseline(api, (listed.body.repos ?? []).filter((r) => PROTECTED.includes(r.name)));
  const missing = PROTECTED.filter((name) => !repositories.some((r) => r.name === name));
  // Never leave a session on the owner's account: past ten, the oldest is evicted.
  await api.raw('POST', '/api/auth/logout', {}).catch(() => null);
  await evidence('archive-baseline', url, { repositories, missing }, { quiet: true, dir });
  console.error(`Results rebuilt from ${await updateArchive(dir)} runs`);
  process.exit(missing.length ? 3 : 0);
}

assert.ok(values.yes, 'Nothing ran. Make sure nothing else runs on dev, then pass --yes.');
const { arm } = values;
if (!values.cleanup) {
  assert.ok(ARMS.includes(arm), '--arm is off or on');
  requireArm(arm);
}
const kit = readEnvFile('staging-kit.env');
const api = await signIn(kit.KIT_USERNAME, kit.KIT_PASSWORD);
const { OWNER_TOKEN } = readEnvFile('staging.env', { required: false });
if (OWNER_TOKEN) purgeWhatIsDeleted(new Session(`${url}/api/v1`, { bearer: OWNER_TOKEN }));

if (values.cleanup) {
  for (const arm of ARMS) {
    if (!saved[arm]) continue;
    const { id, name } = saved[arm];
    requireMeasured(name);
    const gone = await api.raw('DELETE', `/api/v1/repos/${id}?confirm=${encodeURIComponent(name)}`);
    console.error(`${name}: ${gone.status}`);
    if (gone.ok) delete saved[arm];
  }
  await save();
  process.exit(Object.keys(saved).length ? 3 : 0);
}

if (runs < MIN_RUNS) console.error(`Fewer than ${MIN_RUNS} runs proves the tool works; it is not a result.`);
const { BENCH_KEY } = readEnvFile('staging-bench.env');
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
Object.assign(process.env, { YONEDA_USERNAME: api.identifier, YONEDA_PASSWORD: kit.KIT_PASSWORD, BENCH_KEY });
const session = await connect(url, values.client, { cookie: api.cookie });
await session.preflight();

saved[arm] ??= await importArm(api, { name: repoName(arm, stampOf(new Date()).toLowerCase().replace(/[^a-z0-9]/g, '')), source: plan.source, maxCommits: plan.maxCommits });
await save();
const { id: repo, name } = saved[arm];
for (let run = 1; run <= runs; run++) {
  const stamp = stampOf(new Date()).replace(/[^0-9]/g, '').slice(0, 14);
  const result = await measureRun({ api, session, repo, name, run: stamp, options: plan });
  await evidence(`archive-${arm}-run${run}`, url, { arm, ...result }, { quiet: true, dir });
}
console.error(`Results rebuilt from ${await updateArchive(dir)} runs`);
