#!/usr/bin/env node
// Load test stage 6 from Europe and Asia (docs/load-testing.md, "Distance"), with North America
// as the control: bursts of writers through the regional clients, and the rate limiters. Dev
// only. It prints the plan first and runs nothing without --yes. Evidence: the repository root's
// .local/scale-next/, one file per burst or round; credentials from ~/.config/yonedarepo
// (staging-kit.env, staging-bench.env), never printed.
// Usage: node tools/platform-distance-bench.mjs --dry-run | --yes | --results
//        [--runs 3] [--clients na,eu,ap] [--sizes 100,1000]
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { DEFAULTS, describeDistance, estimateDistance, MIN_RUNS, planDistance } from './fanout-bench/distance-plan.mjs';
import { updateDistance } from './fanout-bench/distance-results.mjs';
import { limitRepository, runDistance } from './fanout-bench/distance.mjs';
import { connect, evidence, rootLocal } from './fanout-bench/driver.mjs';
import { requireDev } from './fanout-bench/guard.mjs';
import { CLIENTS, clientUrl, placedClients, regionalClients } from './fanout-bench/regions.mjs';
import { accountSession, readEnvFile } from './staging/client.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://api.dev.yonedarepo.com' },
    runs: { type: 'string', default: String(DEFAULTS.runs) },
    clients: { type: 'string', default: DEFAULTS.clients.join(',') },
    sizes: { type: 'string', default: DEFAULTS.sizes.join(',') },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    results: { type: 'boolean', default: false },
  },
});
const dir = rootLocal('scale-next');
if (values.results) {
  console.error(`Results rebuilt from ${await updateDistance(dir)} evidence files`);
  process.exit(0);
}
const url = values.url.replace(/\/$/, '');
requireDev([url]);
const clients = values.clients.split(',');
assert.ok(clients.every((c) => CLIENTS[c]), `--clients is a list of ${Object.keys(CLIENTS)}`);
const sizes = values.sizes.split(',').map(Number);
assert.ok(sizes.every((n) => Number.isInteger(n) && n > 0), '--sizes is a list of writer counts');
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs > 0, '--runs is a whole number');
if (runs < MIN_RUNS) console.error(`Fewer than ${MIN_RUNS} runs proves the tool works; it is not a result.`);

const items = planDistance({ clients, sizes, runs });
console.error(describeDistance(estimateDistance(items)));
if (values['dry-run']) process.exit(0);
if (!values.yes) {
  console.error('Nothing ran. Make sure nothing else runs on dev, then pass --yes.');
  process.exit(2);
}

const kit = readEnvFile('staging-kit.env');
const { BENCH_KEY } = readEnvFile('staging-bench.env');
assert.ok(BENCH_KEY, 'BENCH_KEY is not in staging-bench.env');
const regional = regionalClients({ key: BENCH_KEY, target: url });
const placed = await placedClients(regional, clients);
console.error(`Clients run in: ${JSON.stringify(placed)}`);

const account = await accountSession(url, kit.KIT_USERNAME, kit.KIT_PASSWORD);
Object.assign(process.env, { YONEDA_USERNAME: account.identifier, YONEDA_PASSWORD: kit.KIT_PASSWORD, BENCH_KEY });
const sessions = {};
for (const client of clients) {
  sessions[client] = await connect(url, clientUrl(client), { cookie: account.cookie });
  await sessions[client].preflight();
}
// A session of its own: a burst's cleanup deletes what its session made.
const owner = await connect(url, clientUrl(clients[0]), { cookie: account.cookie });
const limitRepo = await limitRepository(owner);
const label = (client) => CLIENTS[client]?.placed ?? 'two regional clients';
const outcome = await runDistance({
  sessions,
  call: regional.call,
  limitRepo,
  items,
  options: DEFAULTS,
  record: (name, result) => evidence(name, url, { placed, ...result }, { client: label(result.client), quiet: true, dir }),
}).finally(async () => {
  const left = await owner.cleanup();
  if (left.length) console.error(`Left behind: ${left.join(', ')}`);
});
console.error(`Ran ${outcome.done.length} of ${items.length}; results rebuilt from ${await updateDistance(dir)} evidence files`);
for (const [client, why] of Object.entries(outcome.stopped)) console.error(`${client} stopped: ${why}`);
process.exitCode = Object.keys(outcome.stopped).length ? 3 : 0;
