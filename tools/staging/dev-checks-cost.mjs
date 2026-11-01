// What an erase costs and how long a backfill takes, from counts (dev-checks.mjs). Pure: the
// large-repo erase measures the counts, and the backfill's dry run gives its own. A model, always
// labelled as one: analytics on dev are shared with every other test, so the model is what
// belongs to one repository, and the account's totals only bound it from above.
import { LIMITS } from './dev-checks-lib.mjs';

/** USD, Workers Paid list prices read from Cloudflare's pricing pages on 2026-11-01. R2 lists no
 * price for the bulk delete a Worker sends: it is priced as Class A, the most it can be. */
export const PRICES = {
  r2_class_a: 4.5 / 1e6,
  r2_class_b: 0.36 / 1e6,
  do_request: 0.15 / 1e6,
  do_row_written: 1 / 1e6,
  do_row_read: 0.001 / 1e6,
  queue_operation: 0.4 / 1e6,
};
/** Operations a queue message takes: write, read and delete. */
const QUEUE_OPS = 3;
/** Rows written per row deleted: deletes count as writes, each index entry as one more. */
const INDEX_FACTOR = 2;
/** Rows per byte of an unknown database, an upper bound: a real one holds fewer. */
const BYTES_PER_ROW = 200;
/** Authority calls a purge and an erase make outside their steps: two purge targets, the plan, a
 * hold check, the report and the last read. */
const ERASE_CALLS = 6;

/** The requests erasing a repository of `keys` R2 keys, `rows` rows and `refs` refs takes. Both
 * purge passes list each prefix, the second finding it empty. */
export function eraseRequests({ keys, rows, refs = 1, prefixes = 3 }) {
  const pages = Math.ceil(keys / LIMITS.r2Page);
  const steps = Math.ceil(rows / LIMITS.rowsPerStep) + 1;
  const jobs = Math.ceil(steps / LIMITS.stepsPerJob);
  const combiners = 2 + 2 * Math.min(refs, 512);
  return {
    r2_lists: pages + 2 * prefixes,
    r2_deletes: pages,
    do_requests: ERASE_CALLS + steps + LIMITS.shards + combiners,
    do_rows_written: rows * INDEX_FACTOR,
    queue_messages: 1 + jobs,
    erase_jobs: jobs,
    steps,
  };
}

/** Line items in USD and their total. */
export function eraseCost(usage) {
  const lines = {
    r2_lists: usage.r2_lists * PRICES.r2_class_a,
    r2_deletes: usage.r2_deletes * PRICES.r2_class_a,
    do_requests: usage.do_requests * PRICES.do_request,
    do_rows_written: usage.do_rows_written * PRICES.do_row_written,
    queue: usage.queue_messages * QUEUE_OPS * PRICES.queue_operation,
  };
  return { ...lines, total_usd: Object.values(lines).reduce((a, b) => a + b, 0) };
}

/** What `cargo xtask admin erase-backfill --dry-run` printed: one line per object not live
 * (`<state> <object id> <repo or -> <bytes>`), resume cursors and a summary. */
export function parseBackfill(stdout) {
  const entries = [];
  let summary = null;
  for (const line of String(stdout).split('\n')) {
    const row = /^([a-z]+) ([0-9a-f]{64}) (\S+) (\d+)$/.exec(line.trim());
    if (row) entries.push({ state: row[1], object: row[2], repo: row[3] === '-' ? null : row[3], bytes: Number(row[4]) });
    const total = /^\S+: (\d+) objects asked, (\d+) bytes outside live repositories: (\{.*\})$/.exec(line.trim());
    if (total) summary = { asked: Number(total[1]), bytes: Number(total[2]), states: JSON.parse(total[3]) };
  }
  return { entries, summary };
}

/**
 * The estimate of `--confirm`, from a dry run. The walk is one at a time, and each tombstone
 * costs at least one poll (5 s) and `delayMs`, with the live objects it passes costing their
 * delay as well. Rows are not in a dry run: they come from the bytes, an upper bound.
 */
export function backfillEstimate({ entries, summary }, { delayMs = 1000, pollMs = 5000 } = {}) {
  const tombstones = entries.filter((e) => e.state === 'tombstone');
  const bytes = tombstones.reduce((n, e) => n + e.bytes, 0);
  const each = tombstones.map((e) => eraseRequests({ keys: 0, rows: Math.ceil(e.bytes / BYTES_PER_ROW), refs: 1 }));
  const usage = {};
  for (const one of each) for (const [key, n] of Object.entries(one)) usage[key] = (usage[key] ?? 0) + n;
  const walked = summary?.asked ?? entries.length;
  const seconds = (tombstones.length * (pollMs + delayMs) + (walked - tombstones.length) * delayMs) / 1000;
  const largest = tombstones.toSorted((a, b) => b.bytes - a.bytes).slice(0, 5).map(({ repo, bytes: size }) => ({ repo, bytes: size }));
  return {
    tombstones: tombstones.length,
    bytes,
    states: summary?.states ?? null,
    left_alone: entries.filter((e) => ['unnamed', 'blocked'].includes(e.state)).length,
    largest,
    usage,
    cost: tombstones.length ? eraseCost(usage) : null,
    hours_at_least: seconds / 3600,
    note: 'A floor on time and a ceiling on rows. A tombstone in a hook wait, or in its window, stalls the walk: one erase may take 30 minutes before it stops.',
  };
}
