// Where a Landing's time goes: F1, the stale head, repeated on a fresh repository each time as it
// runs first in item 44, once with a client's clock on every step and the platform's own stamps on
// the rest. The queue's wait is `cleared` minus the approval; the landing is the log entry minus
// `cleared`. Stamps come from the Worker, so a slow runner can't pass for a slow platform.
import assert from 'node:assert/strict';
import { cloneOf } from './feature-kit.mjs';
import { change, flightRepo } from './flight-kit.mjs';
import { staleHead } from './flight-failures-flow.mjs';

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)];
const spread = (list) => ({ min: Math.min(...list), median: median(list), max: Math.max(...list) });

/** One flight, with `client` as `{ step: ms }` and what the platform stamped. */
async function flown(kit, reviewer, i) {
  const { repo, crew } = await flightRepo(kit, `kit-f1-${i}`, { switches: { create: true } });
  await kit.pat().post(repo.path('/members'), { account: reviewer.name, role: 'land' });
  const dir = await cloneOf(kit, repo, `f1-${i}`);
  const client = {};
  const started = performance.now();
  let last = started;
  const mark = (name) => {
    const now = performance.now();
    client[name] = Math.round(now - last);
    last = now;
  };
  const { number, head } = await staleHead({ kit, repo, crew, reviewer, dir, mark });
  const totalMs = Math.round(performance.now() - started);
  const read = await change(kit, repo, number);
  const commit = await kit.pat().get(repo.path(`/commits/${head}`));
  const approved = Math.max(...(commit.reviews ?? []).map((r) => r.recorded_at ?? 0));
  const decisions = (read.clearances ?? []).filter((c) => c.head === head);
  const cleared = decisions.find((c) => c.decision === 'cleared');
  const { entries } = await kit.pat().get(repo.path('/txlog?after=0&limit=100'));
  const landed = entries.find((e) => e.new === read.landed_commit && e.refname === 'refs/heads/main') ?? entries.at(-1);
  return {
    repo: repo.id,
    total_ms: totalMs,
    client,
    server: {
      approved_at: approved || null,
      cleared_at: cleared?.at ?? null,
      landed_at: landed?.committed_at_ms ?? null,
      queue_wait_ms: approved && cleared ? cleared.at - approved : null,
      land_ms: cleared && landed ? landed.committed_at_ms - cleared.at : null,
      decisions: decisions.length,
    },
  };
}

export async function flightTimes(kit, { credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const runs = Number(process.env.F1_RUNS ?? 10);
  assert.ok(Number.isInteger(runs) && runs > 0, 'F1_RUNS is a count');
  const reviewer = await credentials.second();
  m.runs = [];
  for (let i = 1; i <= runs; i++) {
    const run = await flown(kit, reviewer, i);
    m.runs.push(run);
    console.log(`  F1 ${String(i).padStart(2)}: ${(run.total_ms / 1000).toFixed(1)} s, queue ${run.server.queue_wait_ms} ms, land ${run.server.land_ms} ms`);
  }
  m.total_s = spread(m.runs.map((r) => Math.round(r.total_ms / 100) / 10));
  for (const key of ['queue_wait_ms', 'land_ms']) {
    const known = m.runs.map((r) => r.server[key]).filter((v) => v !== null);
    if (known.length) m[key] = spread(known);
  }
  m.slowest_steps = Object.keys(m.runs[0].client).map((step) => ({ step, ...spread(m.runs.map((r) => r.client[step])) }));
}
