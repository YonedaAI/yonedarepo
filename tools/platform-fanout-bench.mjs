#!/usr/bin/env node
// Load against a deployed platform Worker, driven through the bench client Worker
// (tools/fanout-bench) so the load is not capped by this machine's connections and is
// measured from aws:us-east-1. An explicit, separate command: it creates a repository and
// repository tokens, and deletes them when it ends. Credentials: YONEDA_USERNAME / YONEDA_PASSWORD; BENCH_KEY for the
// bench client. Evidence goes to .local/platform-live/.
//
// --workload picks what runs:
//   burst (default)  --writers N writers commit and land at once, then read back (burst.mjs)
//   sustained        open-loop arrivals at each of --rates lands/s for --step-seconds, until
//                    a step misses; reports the knee (sustained.mjs)
//   skew             --writers N writers whose declared reads meet each other's writes, with
//                    and without the reads, checked for serializability (skew.mjs)
//   reads            --burst N concurrent reads per read source; one refusal fails (reads.mjs)
// --mode picks the landing mode per request (changeset|batch) where the target allows it.
//
// Usage: node tools/platform-fanout-bench.mjs --url https://<platform> --client https://<bench-client> [--workload burst] ...
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { burst } from './fanout-bench/burst.mjs';
import { connect, evidence } from './fanout-bench/driver.mjs';
import { reads, SOURCES } from './fanout-bench/reads.mjs';
import { skew } from './fanout-bench/skew.mjs';
import { estimate, sustained } from './fanout-bench/sustained.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    client: { type: 'string' },
    workload: { type: 'string', default: 'burst' },
    writers: { type: 'string', default: '1000' },
    principals: { type: 'string', default: 'tokens' },
    mode: { type: 'string' },
    // sustained
    rates: { type: 'string', default: '50,100,200,400,800' },
    'step-seconds': { type: 'string', default: '120' },
    'per-shard': { type: 'string', default: '1' },
    'segment-seconds': { type: 'string', default: '120' },
    arrivals: { type: 'string', default: 'poisson' },
    warmup: { type: 'string', default: '5' },
    yes: { type: 'boolean', default: false },
    // skew
    'skew-reads': { type: 'string', default: '1' },
    runs: { type: 'string', default: '1' },
    // reads
    burst: { type: 'string', default: '1000' },
    sources: { type: 'string', default: Object.keys(SOURCES).join(',') },
  },
});
assert.ok(values.url && values.client, 'Pass --url (platform) and --client (bench client)');
assert.ok(['burst', 'sustained', 'skew', 'reads'].includes(values.workload), '--workload is burst, sustained, skew or reads');
assert.ok(['session', 'tokens'].includes(values.principals), '--principals is session or tokens');
assert.ok(!values.mode || ['changeset', 'batch'].includes(values.mode), '--mode is changeset or batch');
const url = values.url.replace(/\/$/, '');
const positive = (name) => {
  const n = Number(values[name]);
  assert.ok(Number.isFinite(n) && n > 0, `--${name} must be a positive number`);
  return n;
};
const mode = values.mode;

// Every repository the workload creates is deleted afterwards, pass or fail; the evidence
// file keeps the results.
const session = await connect(url, values.client);
try {
  if (values.workload === 'burst') {
    const result = await burst(session, { writers: positive('writers'), principals: values.principals, mode });
    await evidence(`fanout-${result.writers}-${values.principals}-${mode ?? 'default'}`, url, result);
  } else if (values.workload === 'sustained') {
    const rates = values.rates.split(',').map(Number);
    assert.ok(rates.length && rates.every((r) => Number.isFinite(r) && r > 0), '--rates is a list of lands/s');
    const o = { rates, step_s: positive('step-seconds'), per_shard: positive('per-shard'), segment_s: positive('segment-seconds'), arrivals: values.arrivals, warmup_s: Number(values.warmup), mode };
    assert.ok(o.per_shard <= 50 && o.segment_s <= 180, '--per-shard is at most 50 and --segment-seconds at most 180');
    assert.ok(['poisson', 'fixed'].includes(o.arrivals), '--arrivals is poisson or fixed');
    const planned = estimate(o);
    console.error(`planned: ${JSON.stringify(planned)}`);
    if (planned.requests > 2_000_000 && !values.yes) {
      console.error(`${planned.requests} platform requests exceed 2,000,000; pass --yes to run`);
      process.exit(2);
    }
    const result = await sustained(session, o);
    await evidence(`sustained-${rates.join('_')}-${o.step_s}s-${mode ?? 'default'}`, url, { estimate: planned, ...result });
  } else if (values.workload === 'skew') {
    const o = { writers: positive('writers'), k: positive('skew-reads'), runs: positive('runs'), mode };
    const result = await skew(session, o);
    await evidence(`skew-${o.writers}x${o.k}-${mode ?? 'default'}`, url, result);
    process.exitCode = result.serializable ? 0 : 1;
  } else {
    const sources = values.sources.split(',');
    assert.ok(sources.every((s) => SOURCES[s]), `--sources from ${Object.keys(SOURCES).join(',')}`);
    const result = await reads(session, { burst: positive('burst'), principals: values.principals, sources });
    await evidence(`reads-${result.burst}-${values.principals}`, url, result);
    process.exitCode = result.passed ? 0 : 1;
  }
} finally {
  const left = await session.cleanup();
  if (left.length) {
    console.error(`Left repositories: ${left.join(', ')}`);
    process.exitCode ||= 1;
  }
}
