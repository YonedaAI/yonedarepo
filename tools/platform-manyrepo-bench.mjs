#!/usr/bin/env node
// Many repositories at once against the dev platform Worker (tools/fanout-bench/manyrepo.mjs):
// repositories come from a saved file and are reused, credentials are fresh each run and
// revoked after it, and the load goes out through the bench client's relay. `--principals pat`
// sends it with personal access tokens, the arm that reaches D1 and the account authorities.
// Each run ends with one check per repository, which starts containers and costs money:
// `--no-checks` leaves them out.
// Evidence goes to .local/platform-live/, one timestamped file per run.
// Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the bench client;
// CF_ANALYTICS_TOKEN for queue depth, dead letters and D1 traffic (optional).
// Usage: node tools/platform-manyrepo-bench.mjs --url https://<platform> --client https://<bench-client> [--repos 100] [--writers 10]
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { cloudflareReaders } from './fanout-bench/cf-analytics.mjs';
import { connect, evidence } from './fanout-bench/driver.mjs';
import { devSpec, requireDev } from './fanout-bench/guard.mjs';
import { manyRepo } from './fanout-bench/manyrepo.mjs';
import { ensurePool, poolPath } from './fanout-bench/repo-pool.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    client: { type: 'string' },
    client2: { type: 'string' },
    repos: { type: 'string', default: '100' },
    writers: { type: 'string', default: '10' },
    principals: { type: 'string', default: 'tokens' },
    pats: { type: 'string', default: '10' },
    'no-checks': { type: 'boolean', default: false },
    'pool-file': { type: 'string' },
    'target-p95-ms': { type: 'string' },
    'sample-seconds': { type: 'string', default: '15' },
    'settle-seconds': { type: 'string', default: '30' },
    local: { type: 'boolean', default: false },
  },
});
assert.ok(values.url && values.client, 'Pass --url (platform) and --client (bench client)');
assert.ok(['tokens', 'pat'].includes(values.principals), '--principals is tokens or pat');
requireDev([values.url, values.client, values.client2], { local: values.local });
const url = values.url.replace(/\/$/, '');
const spec = devSpec();
const token = process.env.CF_ANALYTICS_TOKEN;

const session = await connect(url, values.client, { client2: values.client2 });
await session.preflight();
const count = Number(values.repos);
const writers = Number(values.writers);
const repos = await ensurePool(session, { file: values['pool-file'] ?? poolPath('manyrepo'), size: count, prefix: 'many' });
const result = await manyRepo(session, {
  repos,
  writers,
  principals: values.principals,
  pats: Number(values.pats),
  checks: !values['no-checks'],
  ...(values['target-p95-ms'] ? { target_ms: Number(values['target-p95-ms']) } : {}),
  analytics: token && !values.local ? cloudflareReaders({ token, spec }) : null,
  sample_ms: Number(values['sample-seconds']) * 1000,
  settle_ms: Number(values['settle-seconds']) * 1000,
});
await evidence(`manyrepo-${count}x${writers}-${values.principals}`, url, result);
process.exitCode = result.summary.what_broke ? 3 : 0;
