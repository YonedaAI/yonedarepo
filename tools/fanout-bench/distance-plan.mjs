// Load test stage 6, the part about distance (docs/load-testing.md): what a run sends and how
// long it takes, written before a run so the numbers are checked. A burst of writers from a
// regional client, on today's path: the client is far away and the data is in enam. `limits`
// checks the two rate limiters from each region, and that a fleet behind one address isn't
// caught by them. Every figure of time here is an estimate from the runs in that doc.
import { STOP, stopReasons } from './stop.mjs';

export const MIN_RUNS = 3;
export const DEFAULTS = { runs: MIN_RUNS, clients: ['na', 'eu', 'ap'], sizes: [100, 1000], publicReads: 360, signIns: 40, bothReads: 240 };
/** The request budget's targets: land at 5,000 writers, and any read during a burst. */
export const TARGETS = { land_p95_ms: 10_000, read_p95_ms: 1_000 };
/** The limiters' window, and a margin: a round starts on empty counters. */
export const LIMIT_RESET_MS = 65_000;
/** What `infra/envs/dev.json` sets, to compare what really got through with. */
export const LIMITS = { public: 300, auth: 30 };
const BURST_SECONDS = (writers) => 45 + writers * 0.14;

export function planDistance({ clients, sizes, runs }) {
  const items = [];
  for (let run = 1; run <= runs; run++) {
    for (const writers of sizes) for (const client of clients) items.push({ kind: 'burst', run, client, writers });
    for (const client of clients) items.push({ kind: 'limits', run, client });
    if (clients.includes('eu') && clients.includes('ap')) items.push({ kind: 'limits-both', run, client: 'eu+ap' });
  }
  return items;
}

/** Requests one burst sends: a commit, a landing and a read per writer, a token per writer, and
 * about 30 for setup, projection polls and cleanup. */
export const burstRequests = (writers) => writers * 4 + 30;
export const limitRequests = (o) => o.publicReads + o.signIns;

export function estimateDistance(items, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const bursts = items.filter((i) => i.kind === 'burst');
  const rounds = items.length - bursts.length;
  const requests = bursts.reduce((n, i) => n + burstRequests(i.writers), 0) + rounds * limitRequests(o);
  const seconds = bursts.reduce((n, i) => n + BURST_SECONDS(i.writers), 0) + rounds * (LIMIT_RESET_MS / 1000 + 15);
  return { items: items.length, bursts: bursts.length, limit_rounds: rounds, repositories: bursts.length + 1, requests, minutes: Math.ceil(seconds / 60) };
}

export function describeDistance(e) {
  return [
    `Stage 6: ${e.bursts} bursts and ${e.limit_rounds} limiter rounds, ${e.repositories} test repositories made and deleted.`,
    `About ${e.requests} requests and ${e.minutes} minutes (estimate). Bursts land on main of a repository of their own, in enam.`,
    'No new Worker: the regional clients exist. No container and no model. Cost basis: Workers, Durable Object, R2 and D1 requests at list price, under $0.10 for this count.',
  ].join('\n');
}

/** Why a burst breaks the stage's stop rules, as docs/load-testing.md has them. */
export function burstStops(result) {
  const total = result.writers * 3;
  const worked = result.commit.ok + result.land.ok + result.read.correct;
  const limits = result.overloaded ?? 0;
  const writes = stopReasons({ total, errors: total - worked, p95_ms: result.land.client.p95_ms, target_ms: TARGETS.land_p95_ms, limits });
  const reads = stopReasons({ total, errors: 0, p95_ms: result.read.client.p95_ms, target_ms: TARGETS.read_p95_ms });
  return [...new Set([...writes, ...reads])];
}

/** One limiter round's answers: what got through, what was refused, and anything else. */
export function tally(rows) {
  const allowed = rows.filter((r) => r.status === 200 || r.status === 401).length;
  const refused = rows.filter((r) => r.status === 429).length;
  return { sent: rows.length, allowed, refused, other: rows.length - allowed - refused, edges: [...new Set(rows.map((r) => r.edge).filter(Boolean))] };
}

/** Whether a round shows its limiter working: it refused, and what passed is near the limit.
 * Counts are approximate by Cloudflare's docs, so only an order of magnitude is judged. */
export function limitHeld({ allowed, refused }, limit) {
  return refused > 0 && allowed >= limit * 0.5 && allowed <= limit * 2;
}

export const STOP_RULES = `errors above ${STOP.errors * 100}%, p95 over ${STOP.p95_factor}x target, or a Cloudflare limit error`;
