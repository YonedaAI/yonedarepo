// The latency matrix's plan: each pair of client region and data region, what a pair sends, and
// what a whole matrix costs. Written before a run so the numbers are checked, not hoped for.
import { blobIds } from './git-forms.mjs';
import { CLIENTS, DATA_REGIONS } from './regions.mjs';

export const MIN_RUNS = 3;
export const DEFAULTS = { runs: MIN_RUNS, reads: 8, clones: 3, lands: 3, pushes: 2, samples: 8, files: 40 };
const SECONDS_PER_PAIR = 22;

/** A test repository's name; only these can take a hint (repo-region-hint.ts). */
export const repoName = (stamp, run, client, data) => `region-hint-${stamp}-${run}-${client}-${data}`;

/** A flat seed: `f00.txt`… of about 2 KB, different per repository so no cache is shared. */
export function seedFiles(name, count = DEFAULTS.files) {
  const files = {};
  for (let i = 0; i < count; i++) files[`f${String(i).padStart(2, '0')}.txt`] = `${name} file ${i}\n${'x'.repeat(40)}\n`.repeat(40);
  return files;
}
export const seedBlobs = (name, count) => blobIds(seedFiles(name, count));

/** Requests one pair sends: create, where, three reads per sample, clones, commits, pushes. */
export const pairRequests = (o) => 2 + o.reads * 3 + o.clones * 3 + o.lands * 2 + o.pushes * 2;

/** Pieces each client's probe times: five shared, two per data region, each `samples` times. */
export const probeReads = (o, data) => (6 + 2 * data) * o.samples;

/** What a matrix sends and how long it takes; clients run side by side, a data region at a time. */
export function estimateMatrix(options = {}) {
  const o = { ...DEFAULTS, clients: Object.keys(CLIENTS), data: DATA_REGIONS, ...options };
  const pairs = o.clients.length * o.data.length * o.runs;
  const repositories = pairs;
  const requests = pairs * pairRequests(o) + o.clients.length * o.runs * probeReads(o, o.data.length);
  const seconds = o.runs * o.data.length * SECONDS_PER_PAIR + o.runs * 20 + repositories * 2;
  return { pairs, repositories, requests, minutes: Math.ceil(seconds / 60), ...o };
}

export function describeMatrix(e) {
  return [
    `Matrix: ${e.runs} runs of ${e.clients.length} client regions × ${e.data.length} data regions: ${e.pairs} pairs, ${e.repositories} test repositories made and deleted.`,
    `About ${e.requests} requests and ${e.minutes} minutes. Reads ${e.reads}, clones ${e.clones}, lands ${e.lands}, pushes ${e.pushes} per pair; ${e.samples} samples per piece.`,
    'Cost basis: Workers, Durable Object, R2 and D1 requests at list price, under $0.01 for this count; no container and no model.',
  ].join('\n');
}
