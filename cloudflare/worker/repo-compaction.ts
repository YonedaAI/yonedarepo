// Log compaction (repo_store/maintenance/compaction.rs): keeps the authority's SQL log a
// bounded tail. The authority decides what is due and seals it; this adapter only writes
// the two objects to R2, reads them back byte for byte, and reports back, after which the
// authority deletes those rows in one transaction. No network I/O happens inside it, and
// a run that dies at any step is simply run again (the plan reseals the same bytes).
import { archiveKey } from './repo-archive';
import { changeLogHold, skipChangeLog } from './repo-changelog';
import { ApiError, type Call, caller, type Json } from './repo-ops';
import type { Env, Envelope } from './types';

/** Versions per segment (SEGMENT_VERSIONS in yoneda-core): nothing is due below it. */
const SEGMENT_VERSIONS = 1024;
/** Segments one run moves at most; the next run continues. */
const SEGMENTS_PER_RUN = 8;
/** Segments a platform job moves at most. */
const JOB_SEGMENTS = 4;
/** One background check per repository per isolate in this window. */
const CHECK_EVERY_MS = 60_000;
/** The sweep's job kind, sent only with `COMPACTION_SWEEP` on (an older Worker acks it). */
export const COMPACT_JOB = 'platform_compact';
/** Minutes one pass over every repository takes. */
const SWEEP_MINUTES = 24 * 60;
/** Ranges split ids by their first four hex digits (`r` + 20 random ones). */
const ID_PREFIXES = 16 ** 4;
/** Repositories one minute may send: 1.4 million a day. */
const SWEEP_LIMIT = 1_000;
/** The most `sendBatch` takes. */
const SEND_BATCH = 100;
const AGAIN_SECONDS = 60;
const GONE_CODES = ['GONE', 'NOT_FOUND'];

async function writeVerified(env: Env, repo: string, sealed: Json) {
  const key = archiveKey(repo, sealed.key);
  await env.OBJECTS.put(key, sealed.body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { digest: sealed.digest },
  });
  const back = await env.OBJECTS.get(key);
  if ((await back?.text()) !== sealed.body)
    throw new ApiError('ARCHIVE_READBACK', `${sealed.key} did not read back as written`);
}

/** Moves due segments (at most `max`) through `call`; answers the floor and tail size. */
export async function compactLog(env: Env, repo: string, call: Call, max = SEGMENTS_PER_RUN) {
  // A change-log stream still reading older versions holds them in SQL, up to a limit the
  // authority keeps: past it the segment moves anyway and the stream skips to the head.
  const hold = await changeLogHold(env, repo);
  let held = hold === undefined ? {} : { hold };
  let last: Json = {};
  let segments = 0;
  while (segments < max) {
    const plan = await call({ op: 'repo_compact_plan', ...held });
    last = plan;
    if (plan.hold_released) {
      await skipChangeLog(env, repo, plan.head, 'size');
      held = {};
    }
    if (!plan.due) break;
    await writeVerified(env, repo, plan.segment);
    await writeVerified(env, repo, plan.checkpoints);
    last = await call({
      op: 'repo_compact_done',
      start: plan.start,
      end: plan.end,
      segment_digest: plan.segment.digest,
      checkpoints_digest: plan.checkpoints.digest,
      ...held,
    });
    segments++;
  }
  const { floor, head, tail_rows, retention, held: stopped } = last;
  // Superfan alarms on this line (tail.ts): a hold with no limit would otherwise be silent.
  if (stopped?.stalled)
    console.error(
      JSON.stringify({ event: 'compaction.stalled', repo, ...stopped, floor, head, tail_rows }),
    );
  return {
    segments,
    floor,
    head,
    tail_rows,
    retention,
    more: segments === max,
    ...(stopped ? { held: stopped } : {}),
  };
}

/** One run as the platform. Never throws: a failure is logged and a later run tries again. A
 * repository that has gone has nothing to move, and that is no failure. */
async function compactQuietly(env: Env, repo: string) {
  try {
    return await compactLog(env, repo, caller(env, repo, { _system: 'compact' }), JOB_SEGMENTS);
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : 'COMPACTION';
    if (GONE_CODES.includes(code)) return null;
    console.error(
      JSON.stringify({
        event: 'compaction.failed',
        repo,
        code,
        message: String(e?.message ?? e).slice(0, 200),
      }),
    );
    return null;
  }
}

const checked = new Map<string, number>();

/** After a landing (derive job): compacts when the log may hold a due segment. */
export async function compactAfterLanding(env: Env, repo: string, version: number) {
  if (!(version > SEGMENT_VERSIONS) || (checked.get(repo) ?? 0) > Date.now() - CHECK_EVERY_MS)
    return null;
  checked.set(repo, Date.now());
  return compactQuietly(env, repo);
}

/** The ids one minute of the day covers, by their first hex digits: `[from, to)`. */
export function sweepRange(now: number): [string, string] {
  const slot = Math.floor(now / 60_000) % SWEEP_MINUTES;
  const edge = (at: number) => {
    const prefix = Math.floor((at * ID_PREFIXES) / SWEEP_MINUTES);
    // Past every hex digit: the top of the last range.
    return prefix === ID_PREFIXES ? 'rg' : `r${prefix.toString(16).padStart(4, '0')}`;
  };
  return [edge(slot), edge(slot + 1)];
}

/**
 * Every minute, behind `COMPACTION_SWEEP`: sends a compaction job for each repository in this
 * minute's range, so an idle one is looked at once a day and a due segment or a stalled hold
 * needs no further landing to be seen. No cursor or row marks progress: an overrun or a lost
 * job only waits for tomorrow. Answers how many it sent.
 */
export async function sweepCompaction(env: Env, now = Date.now()) {
  if (env.COMPACTION_SWEEP !== 'on') return 0;
  const [from, to] = sweepRange(now);
  const { results } = await env.INDEX.prepare(
    'SELECT id FROM platform_repos WHERE id>=? AND id<? ORDER BY id LIMIT ?',
  )
    .bind(from, to, SWEEP_LIMIT)
    .all<{ id: string }>();
  // Past the limit the same ids go unvisited every day, so it must not pass quietly.
  if (results.length === SWEEP_LIMIT)
    console.error(JSON.stringify({ event: 'compaction.sweep_full', from, to }));
  for (let at = 0; at < results.length; at += SEND_BATCH) {
    const jobs = results.slice(at, at + SEND_BATCH).map(({ id }) => ({
      body: { v: 1, kind: COMPACT_JOB, repo_id: id, job_id: `compact-${id}` } as Envelope,
    }));
    await env.PLATFORM_QUEUE.sendBatch(jobs);
  }
  return results.length;
}

/** The sweep's queue job: one run, and another shortly while segments remain due. */
export async function compactionJob(env: Env, envelope: Envelope) {
  const out = await compactQuietly(env, envelope.repo_id);
  if (out?.more) await env.PLATFORM_QUEUE.send(envelope, { delaySeconds: AGAIN_SECONDS });
  return out;
}
