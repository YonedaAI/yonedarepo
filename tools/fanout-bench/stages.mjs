// Load test stages 2 and 3 of docs/load-testing.md as one plan: the sizes below, at least three
// runs of each, in the plan's order. A run that trips a stop rule ends its stage.
import { manyRepo } from './manyrepo.mjs';
import { ensurePool, poolPath } from './repo-pool.mjs';
import { requestsPerSample } from './sampler.mjs';
import { estimate, sustained } from './sustained.mjs';

export const MIN_RUNS = 3;
export const STAGE2 = { sizes: [20, 100, 500, 1000], writers: 10, arms: ['tokens', 'pat'], settle_s: 30, sample_s: 15 };
export const STAGE3 = {
  seconds: 1800,
  per_shard: 1,
  segment_s: 60,
  settle_s: 120,
  sample_s: 30,
  arms: [
    { name: 'one-repo', repos: 1, rate: 100, layout: 'spread' },
    // The old shape: every write in one search partition.
    { name: 'one-repo-single-dir', repos: 1, rate: 100, layout: 'single' },
    { name: 'twenty-repos', repos: 20, rate: 5, layout: 'spread' },
  ],
};
// Time assumptions for the printed estimate, from docs/load-testing.md: repository create 3.5 s,
// 100+ landings/s across repositories. Token rates are guessed; a real run records the real time.
const CREATE_S = 3.5;
const CREATE_WIDTH = 20;
const TOKENS_PER_S = 100;
const LANDINGS_PER_S = 100;
const STAGE3_OVERHEAD_S = 35;

/** The runs in order: stage 3 before 2, as global-scale-plan.md lists them. With two clients,
 * stage 2's largest size repeats on both, to show whether one client was the limit. */
export function planRuns({ stages = ['3', '2'], runs = MIN_RUNS, sizes = STAGE2.sizes, seconds = STAGE3.seconds, arms = STAGE3.arms, clients = 1 } = {}) {
  const items = [];
  for (const stage of stages) {
    if (stage === '3')
      for (const arm of arms) for (let n = 1; n <= runs; n++) items.push({ stage, run: n, arm: arm.name, repos: arm.repos, rate: arm.rate, layout: arm.layout, seconds, clients: 1 });
    if (stage === '2') {
      for (const size of sizes) for (let n = 1; n <= runs; n++) for (const arm of STAGE2.arms) items.push({ stage, run: n, arm, repos: size, writers: STAGE2.writers, clients: 1 });
      if (clients > 1) for (let n = 1; n <= runs; n++) for (const arm of STAGE2.arms) items.push({ stage, run: n, arm, repos: Math.max(...sizes), writers: STAGE2.writers, clients: 2 });
    }
  }
  return items;
}

/** One run's platform requests and seconds, by part. */
export function estimateRun(item, { pats = 10 } = {}) {
  if (item.stage === '2') {
    const writers = item.repos * item.writers;
    const credentials = item.arm === 'pat' ? pats * 2 : writers * 2;
    const seconds = credentials / TOKENS_PER_S + Math.max(10, writers / LANDINGS_PER_S) + STAGE2.settle_s;
    const sampler = (Math.ceil(seconds / STAGE2.sample_s) + 1) * requestsPerSample(item.repos);
    return { measured: writers * 2, setup: credentials + item.repos, sampler, bench_invocations: Math.ceil(writers / 5) * 2, seconds: Math.ceil(seconds) };
  }
  const planned = estimate({ rates: [item.rate], step_s: item.seconds, per_shard: STAGE3.per_shard, repo_count: item.repos });
  const slots = planned.max_shards * item.repos;
  const measured = Math.round(item.rate * item.seconds * 2) * item.repos;
  const seconds = item.seconds + STAGE3_OVERHEAD_S + STAGE3.settle_s + (slots * 2) / TOKENS_PER_S;
  const sampler = (Math.ceil(seconds / STAGE3.sample_s) + 1) * requestsPerSample(item.repos);
  return { measured, setup: slots * 2 + item.repos, sampler, bench_invocations: slots * Math.ceil(item.seconds / STAGE3.segment_s), seconds: Math.ceil(seconds) };
}

/** The whole plan's cost, printed before anything starts. `poolMissing` repositories to make. */
export function estimatePlan(items, { pats = 10, poolMissing = 0 } = {}) {
  const parts = items.map((item) => estimateRun(item, { pats }));
  const sum = (key) => parts.reduce((n, p) => n + p[key], 0);
  const poolSeconds = Math.ceil(poolMissing / CREATE_WIDTH) * CREATE_S;
  const byStage = (stage) => {
    const chosen = items.map((item, i) => (item.stage === stage ? parts[i] : null)).filter(Boolean);
    return { runs: chosen.length, requests: chosen.reduce((n, p) => n + p.measured + p.setup + p.sampler, 0), seconds: chosen.reduce((n, p) => n + p.seconds, 0) };
  };
  return {
    runs: items.length,
    requests: { measured: sum('measured'), setup: sum('setup') + poolMissing, sampler: sum('sampler'), total: sum('measured') + sum('setup') + sum('sampler') + poolMissing },
    bench_invocations: sum('bench_invocations'),
    seconds: Math.ceil(sum('seconds') + poolSeconds),
    stage_2: byStage('2'),
    stage_3: byStage('3'),
    assumes: `repository create ${CREATE_S} s, ${TOKENS_PER_S} tokens/s, ${LANDINGS_PER_S} landings/s; stops early if a rule trips`,
  };
}

const hours = (seconds) => `${(seconds / 3600).toFixed(1)} h`;

/** The estimate as a person reads it, before saying yes. */
export function describePlan(cost) {
  return [
    `Plan: ${cost.runs} runs, about ${hours(cost.seconds)}, about ${cost.requests.total.toLocaleString('en-US')} platform requests`,
    `  measured ${cost.requests.measured.toLocaleString('en-US')}, setup ${cost.requests.setup.toLocaleString('en-US')}, sampler ${cost.requests.sampler.toLocaleString('en-US')}; bench client invocations ${cost.bench_invocations.toLocaleString('en-US')}`,
    `  stage 3: ${cost.stage_3.runs} runs, ${hours(cost.stage_3.seconds)}, ${cost.stage_3.requests.toLocaleString('en-US')} requests`,
    `  stage 2: ${cost.stage_2.runs} runs, ${hours(cost.stage_2.seconds)}, ${cost.stage_2.requests.toLocaleString('en-US')} requests`,
    `  Assumes ${cost.assumes}. Cost in dollars is not estimated here.`,
  ].join('\n');
}

/** Runs `items`; `record(name, result)` keeps each run's evidence. A run that trips a stop rule
 * skips the rest of its stage. Answers what ran and what stopped. */
export async function runPlan(session, items, { record, analytics = null, pats = 10, pool = poolPath, sample = true, log = (text) => console.error(text) }) {
  const stopped = {};
  const done = [];
  for (const [index, item] of items.entries()) {
    if (stopped[item.stage]) continue;
    log(`[${index + 1}/${items.length}] stage ${item.stage} ${item.arm} ${item.repos} repos, run ${item.run}, ${item.clients} client(s)`);
    session.useClients(item.clients);
    const common = { stage: item.stage, analytics, pats, sample };
    let result;
    if (item.stage === '2') {
      const repos = await ensurePool(session, { file: pool('stage2'), size: item.repos, prefix: 'stage2' });
      result = await manyRepo(session, { ...common, repos, writers: item.writers, principals: item.arm, checks: false, sample_ms: STAGE2.sample_s * 1000, settle_ms: (item.settle_s ?? STAGE2.settle_s) * 1000 });
    } else {
      const repos = await ensurePool(session, { file: pool(`stage3-${item.arm}`), size: item.repos, prefix: `stage3-${item.arm}` });
      result = await sustained(session, { ...common, repos, rates: [item.rate], step_s: item.seconds, per_shard: STAGE3.per_shard, segment_s: item.segment_s ?? STAGE3.segment_s, arrivals: 'poisson', warmup_s: 5, layout: item.layout, sample_ms: STAGE3.sample_s * 1000, settle_ms: (item.settle_s ?? STAGE3.settle_s) * 1000 });
    }
    const name = item.stage === '2' ? `stage2-${item.repos}x${item.writers}-${item.arm}-c${item.clients}` : `stage3-${item.arm}`;
    await record(name, result);
    done.push({ ...item, what_broke: result.summary.what_broke });
    if (result.summary.what_broke) {
      stopped[item.stage] = result.summary.what_broke;
      log(`Stage ${item.stage} stopped: ${result.summary.what_broke}`);
    }
  }
  return { done, stopped };
}
