#!/usr/bin/env node
// Watches prod after a ship: every poll checks each /health at the shipped revision and runs
// Superfan, then counts open findings that are new since the deploy began. Superfan mails the
// details privately (cloudflare/superfan/notify.ts); only counts ever reach this public log.
// It never rolls back: docs/ship-pipeline.md says why and how to by hand.
//   node tools/ship/monitor.mjs --revision <sha> --since <epoch ms> [--minutes 30] [--interval 300]
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEnvFile, sleep } from '../staging/client.mjs';

const SUPERFAN = 'https://yonedarepo-prod-superfan.mlong-f01.workers.dev';
const HEALTH = ['https://yonedarepo.com/health', 'https://yonedarepo-prod-platform.mlong-f01.workers.dev/health'];
/** Polls in a row that may fail to read: one blip is the network, two say something is wrong. */
const MAX_MISSES = 2;
const TIMEOUT_MS = 120_000;

export const plural = (n) => `${n} new finding${n === 1 ? '' : 's'}`;

/** Open findings that are not in `known` or were first seen since the deploy began. */
export const fresh = (open, known, since) => open.filter((f) => !known.has(f.id) || Date.parse(f.first_seen) >= since);

/** `{ ok, line }`; `line` is safe for a public log. */
export async function watch({ fetch, wait = sleep, log = console.log, token, superfan = SUPERFAN, health = HEALTH, revision, since, polls, intervalMs }) {
  const json = async (url, init) => {
    try {
      const answer = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return answer.ok ? await answer.json() : null;
    } catch {
      return null;
    }
  };
  const authorized = { headers: { authorization: `Bearer ${token}` } };
  const open = async () => (await json(`${superfan}/findings?status=open&limit=200`, authorized))?.findings ?? null;
  const live = async () => {
    const replies = await Promise.all(health.map((url) => json(url)));
    return replies.filter((reply) => reply?.revision === revision).length;
  };
  let before = await open();
  if (!before) {
    await wait(intervalMs);
    before = await open();
  }
  if (!before) return { ok: false, line: 'The monitor could not read Superfan.' };
  const known = new Set(before.filter((f) => Date.parse(f.first_seen) < since).map((f) => f.id));
  let misses = 0;
  let watched = false;
  for (let poll = 1; poll <= polls; poll++) {
    if (poll > 1) await wait(intervalMs);
    const healthy = await live();
    const run = await json(`${superfan}/run`, { ...authorized, method: 'POST' });
    const now = await open();
    if (now) {
      const count = fresh(now, known, since).length;
      if (count) return { ok: false, line: plural(count) };
    }
    watched ||= run?.outcome === 'ok';
    const read = healthy === health.length && run && now;
    misses = read ? 0 : misses + 1;
    log(`poll ${poll}/${polls}: ${healthy}/${health.length} at ${revision.slice(0, 12)}, superfan ${run?.outcome ?? 'unreadable'}, ${now ? '0 new findings' : 'findings unreadable'}`);
    if (misses >= MAX_MISSES)
      return { ok: false, line: healthy === health.length ? 'The monitor could not read Superfan.' : `${health.length - healthy} of ${health.length} /health not at ${revision.slice(0, 12)}.` };
  }
  // A blind watch must not read as a quiet one.
  if (!watched) return { ok: false, line: 'Superfan had no telemetry on any poll.' };
  return { ok: true, line: `${polls} polls: healthy, 0 new findings.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { revision: { type: 'string' }, since: { type: 'string' }, minutes: { type: 'string', default: '30' }, interval: { type: 'string', default: '300' } },
  });
  const intervalMs = Number(values.interval) * 1000;
  if (!/^[0-9a-f]{40}$/.test(values.revision ?? '') || !Number.isSafeInteger(Number(values.since))) {
    console.log('::error::The monitor needs --revision <sha> and --since <epoch ms>.');
    process.exit(2);
  }
  const result = await watch({
    fetch,
    token: readEnvFile('prod.env').SUPERFAN_READ_TOKEN,
    revision: values.revision,
    since: Number(values.since),
    polls: Math.floor((Number(values.minutes) * 60_000) / intervalMs) + 1,
    intervalMs,
  });
  console.log(result.ok ? result.line : `::error::${result.line}`);
  process.exitCode = result.ok ? 0 : 1;
}
