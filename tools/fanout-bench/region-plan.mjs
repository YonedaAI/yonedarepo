// The same-region test's plan: for each region, today's path and the path a region would have,
// what a run sends and what it costs. Written before a run so the numbers are checked, not hoped
// for. `today` is a client there through the pinned Worker to data in enam, what a person there
// gets now. `region` is the platform's own routes running in that region (repo-region-serve.ts),
// on a repository and an account whose objects started there.
import { blobIds } from './git-forms.mjs';
import { CLIENTS } from './regions.mjs';

export const MIN_RUNS = 3;
export const DEFAULTS = { runs: MIN_RUNS, reads: 8, clones: 3, lands: 3, pushes: 2, signIns: 2, searches: 3, pages: 3, samples: 8, files: 40 };
const SECONDS_PER_ARM = 25;

export const armsOf = (client) => [
  { arm: 'today', data: 'enam' },
  { arm: 'region', data: CLIENTS[client].near, serve: CLIENTS[client].near },
];

/** A test repository's name; only these can take a hint (repo-region-hint.ts). */
export const repoName = (stamp, run, client, arm) => `region-hint-${stamp}-${run}-${client}-${arm}`;
export const accountName = (client, arm) => `regionhint_${client}_${arm}`;

/** A flat seed: `f00.txt`… of about 2 KB, different per repository so no cache is shared. */
export function seedFiles(name, count = DEFAULTS.files) {
  const files = {};
  for (let i = 0; i < count; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `${name} file ${i}\n${'x'.repeat(40)}\n`.repeat(40);
  return files;
}
export const seedBlobs = (name, count) => blobIds(seedFiles(name, count));

/** Requests one arm sends: sign-ins, create, where, three reads per sample, clones, commits,
 * pushes and searches; today's also has the page, which only the front Worker can answer. */
export const armRequests = (o, arm) => o.signIns + 2 + o.reads * 3 + o.clones * 3 + o.lands * 2 + o.pushes * 2 + o.searches + (arm === 'today' ? o.pages * 2 : 0);

/** Pieces each client's probe times, each `samples` times. */
export const probeReads = (o) => (11 + 2 * 2) * o.samples;

/** What a run of the test sends and how long it takes; regions run side by side. */
export function estimateMatrix(options = {}) {
  const o = { ...DEFAULTS, clients: Object.keys(CLIENTS), ...options };
  const arms = o.clients.length * 2 * o.runs;
  const requests = o.runs * o.clients.length * (armRequests(o, 'today') + armRequests(o, 'region') + probeReads(o));
  const seconds = o.runs * (2 * SECONDS_PER_ARM + 20) + arms * 2;
  return { arms, repositories: arms, requests, minutes: Math.ceil(seconds / 60), ...o };
}

export function describeMatrix(e) {
  return [
    `Same-region test: ${e.runs} runs of ${e.clients.length} regions, today's path and the region's: ${e.arms} arms, ${e.repositories} test repositories made and deleted.`,
    `About ${e.requests} requests and ${e.minutes} minutes. Reads ${e.reads}, clones ${e.clones}, lands ${e.lands}, pushes ${e.pushes}, sign-ins ${e.signIns}, searches ${e.searches} per arm; ${e.samples} samples per piece.`,
    'Cost basis: Workers, Durable Object, R2 and D1 requests at list price, under $0.01 for this count; no container and no model.',
  ].join('\n');
}
