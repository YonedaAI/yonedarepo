#!/usr/bin/env node
// Load test stages 2 and 3 in one command (docs/load-testing.md): dev only, at least 3 runs per
// size, one evidence file per run, the doc's results table rebuilt at the end. It prints the
// estimated time and requests first and runs nothing without --yes.
// Credentials come from ~/.config/yonedarepo: staging-kit.env, staging-bench.env (BENCH_KEY) and
// staging.env (CF_ANALYTICS_TOKEN, optional).
// Usage: node tools/platform-load-stages.mjs [--stages 3,2] [--runs 3] [--client2 <url>] --yes
//        node tools/platform-load-stages.mjs --dry-run     the plan and estimate only
//        node tools/platform-load-stages.mjs --results     rebuild the results table only
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { cloudflareReaders } from './fanout-bench/cf-analytics.mjs';
import { connect, evidence } from './fanout-bench/driver.mjs';
import { devSpec, requireDev } from './fanout-bench/guard.mjs';
import { poolPath, readPool } from './fanout-bench/repo-pool.mjs';
import { updateResults } from './fanout-bench/results.mjs';
import { describePlan, estimatePlan, MIN_RUNS, planRuns, runPlan, STAGE2, STAGE3 } from './fanout-bench/stages.mjs';
import { accountSession, readEnvFile } from './staging/client.mjs';

const spec = devSpec();
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: `https://${spec.script}.${spec.subdomain}.workers.dev` },
    client: { type: 'string', default: `https://${spec.prefix}-bench.${spec.subdomain}.workers.dev` },
    client2: { type: 'string' },
    stages: { type: 'string', default: '3,2' },
    runs: { type: 'string', default: String(MIN_RUNS) },
    sizes: { type: 'string', default: STAGE2.sizes.join(',') },
    seconds: { type: 'string', default: String(STAGE3.seconds) },
    pats: { type: 'string', default: '10' },
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    results: { type: 'boolean', default: false },
  },
});

if (values.results) {
  console.log(`Results table rebuilt: ${await updateResults()} rows`);
  process.exit(0);
}
requireDev([values.url, values.client, values.client2]);
const url = values.url.replace(/\/$/, '');
const stages = values.stages.split(',');
assert.ok(stages.length && stages.every((s) => ['2', '3'].includes(s)), '--stages is a list of 2 and 3');
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs >= MIN_RUNS, `--runs is at least ${MIN_RUNS}: the doc reports min, median and max`);
const sizes = values.sizes.split(',').map(Number);
assert.ok(sizes.every((n) => Number.isInteger(n) && n > 0), '--sizes is a list of repository counts');
const seconds = Number(values.seconds);
assert.ok(seconds > 0, '--seconds must be positive');
const pats = Number(values.pats);

const items = planRuns({ stages, runs, sizes, seconds, clients: values.client2 ? 2 : 1 });
const saved = await readPool(poolPath('stage2'), url).catch(() => []);
const needed = stages.includes('2') ? Math.max(...sizes) : 0;
console.error(describePlan(estimatePlan(items, { pats, poolMissing: Math.max(0, needed - saved.length) })));
if (values['dry-run']) process.exit(0);
if (!values.yes) {
  console.error('Nothing ran. Warn the owner, make sure nothing else runs on dev, then pass --yes.');
  process.exit(2);
}

const kit = readEnvFile('staging-kit.env');
const { BENCH_KEY } = readEnvFile('staging-bench.env');
const { CF_ANALYTICS_TOKEN } = readEnvFile('staging.env', { required: false });
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
const account = await accountSession(url, kit.KIT_USERNAME, kit.KIT_PASSWORD);
Object.assign(process.env, { YONEDA_USERNAME: account.identifier, YONEDA_PASSWORD: kit.KIT_PASSWORD, BENCH_KEY });
const session = await connect(url, values.client, { client2: values.client2 });
await session.preflight();
const outcome = await runPlan(session, items, {
  record: (name, result) => evidence(name, url, result),
  analytics: CF_ANALYTICS_TOKEN ? cloudflareReaders({ token: CF_ANALYTICS_TOKEN, spec }) : null,
  pats,
});
console.error(`Ran ${outcome.done.length} of ${items.length} runs; results table has ${await updateResults()} rows`);
for (const [stage, why] of Object.entries(outcome.stopped)) console.error(`Stage ${stage} stopped: ${why}`);
process.exitCode = Object.keys(outcome.stopped).length ? 3 : 0;
