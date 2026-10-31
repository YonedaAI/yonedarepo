// Change-log analytics: after landing, the derive job streams the authority's change
// records to a Basin Pipeline (Iceberg table, queried with Basin SQL). It is never on the
// commit path: emission is best effort, resumes from a per-repository cursor in R2, and is
// at least once, so consumers dedupe on `event_key` (repository + version or ticket). A
// failure is counted and logged and never fails the job or a landing.
//
// Analytics never stops a repository, so the stream gives up history before it keeps a
// repository waiting. A repository with no cursor starts at its head (as a new webhook does:
// start_for_new_hook), and a stream that stalls past MAX_STALL_MS or the authority's
// MAX_HOLD_VERSIONS stops holding log compaction and jumps to the head, leaving a logged gap.
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

/** Rounds per job (each reads up to 100 versions); the next landing's job continues. */
const ROUNDS = 10;
/** Most JSON in one send. Basin refuses a request over 5 MB; a page of 100 versions, each
 * landing a 64-commit merge batch, comes close. */
const MAX_SEND_BYTES = 4_000_000;
/** A stream failing for this long stops holding compaction and the next job jumps. */
const MAX_STALL_MS = 7 * 24 * 60 * 60_000;

export type ChangeEvent = Record<string, string | number | string[]>;
export type ChangeLogState = {
  version: number;
  ticket: number;
  sent: number;
  failures: number;
  last_sent_at?: string;
  last_error?: { code: string; message: string; at: string };
  /** Ranges claimed and not yet confirmed sent: start version → claim time (ms). */
  claims?: Record<string, number>;
  /** When sends began failing (ms); a confirmed send clears it. */
  stalled_since?: number;
  /** Times the stream gave up versions, and the last range it gave up. */
  gaps?: number;
  last_gap?: { from: number; to: number; reason: GapReason; at: string };
};
/** Why a stream gave up versions: too far behind the head, or failing for too long. */
export type GapReason = 'size' | 'age';

/** A claim older than this belongs to a job that died; it no longer holds compaction. */
const CLAIM_LEASE_MS = 10 * 60_000;
const without = (claims: ChangeLogState['claims'], from: number) =>
  Object.fromEntries(Object.entries(claims ?? {}).filter(([start]) => Number(start) !== from));

const stateKey = (repo: string) => `platform/v1/${repo}/changelog/cursor.json`;
const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : undefined);

/** One authority change record as a stream event: optional fields absent, times RFC 3339. */
export function changeEvent(repo: string, record: Json): ChangeEvent {
  const { occurred_at_ms, recorded_at_ms, ...fields } = record;
  const key =
    record.event === 'refused'
      ? `${repo}:t${record.ticket}`
      : record.event === 'merged'
        ? `${repo}:v${record.version}:${record.commit}`
        : `${repo}:v${record.version}`;
  const event: Json = {
    schema: 1,
    event_key: key,
    repo,
    ...fields,
    occurred_at: iso(occurred_at_ms),
    recorded_at: iso(recorded_at_ms),
  };
  return Object.fromEntries(
    Object.entries(event).filter(([, v]) => v !== null && v !== undefined),
  ) as ChangeEvent;
}

const EMPTY: ChangeLogState = { version: 0, ticket: 0, sent: 0, failures: 0 };

const stalledOut = (state: ChangeLogState) =>
  state.stalled_since !== undefined && state.stalled_since < Date.now() - MAX_STALL_MS;

/** Splits a page into sends within MAX_SEND_BYTES. */
export function sendBatches(events: ChangeEvent[]) {
  const batches: ChangeEvent[][] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length + 1;
    if (batches.length === 0 || bytes + size > MAX_SEND_BYTES) {
      batches.push([]);
      bytes = 0;
    }
    batches[batches.length - 1].push(event);
    bytes += size;
  }
  return batches;
}

async function readState(env: Env, repo: string): Promise<ChangeLogState> {
  return (await readCursor(env, repo)).state;
}

/** The lowest version the change-log stream may still read after, while one is bound: its
 * cursor, or the start of a live claim that may yet be given back. Log compaction stays
 * behind it, within the authority's limit, so a given-back range is still in the SQL log.
 * Undefined, holding nothing, with no cursor yet (the stream will start at the head), after
 * failing for too long, or if the cursor cannot be read: a cursor left below the floor
 * still reads, through the archive. */
export async function changeLogHold(env: Env, repo: string) {
  if (!env.CHANGELOG) return undefined;
  try {
    const { state, etag } = await readCursor(env, repo);
    if (!etag || stalledOut(state)) return undefined;
    const live = Object.entries(state.claims ?? {})
      .filter(([, at]) => at > Date.now() - CLAIM_LEASE_MS)
      .map(([start]) => Number(start));
    return Math.min(state.version, ...live);
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 200);
    console.error(JSON.stringify({ event: 'changelog.hold_failed', repo, message }));
    return undefined;
  }
}

/**
 * Gives up everything the stream has not read below `head`: the cursor jumps there and
 * drops its claims, and the gap is logged and kept in the cursor. Never backwards, and a
 * job that claimed a dropped range can no longer return the cursor to it. Refusals are not
 * skipped: they stay in the queue table, and compaction does not touch them. Never throws:
 * answers the new state, or null when the cursor could not be moved, and then the authority
 * releases the hold again on its next plan.
 */
export async function skipChangeLog(env: Env, repo: string, head: number, reason: GapReason) {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cursor = await readCursor(env, repo);
      if (!cursor.etag || cursor.state.version >= head) return cursor.state;
      const gap = { from: cursor.state.version, to: head, reason, at: new Date().toISOString() };
      const state: ChangeLogState = {
        ...cursor.state,
        version: head,
        claims: {},
        stalled_since: undefined,
        gaps: (cursor.state.gaps ?? 0) + 1,
        last_gap: gap,
      };
      if (await swapCursor(env, repo, cursor.etag, state)) {
        console.error(JSON.stringify({ event: 'changelog.gap', repo, ...gap }));
        return state;
      }
    }
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 200);
    console.error(JSON.stringify({ event: 'changelog.skip_failed', repo, message }));
  }
  return null;
}

/** Drops this job's confirmed claim (best effort: an unreleased claim only expires). */
async function release(env: Env, repo: string, from: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cursor = await readCursor(env, repo);
    if (!cursor.etag || !(String(from) in (cursor.state.claims ?? {}))) return;
    const state = {
      ...cursor.state,
      claims: without(cursor.state.claims, from),
      stalled_since: undefined,
    };
    if (await swapCursor(env, repo, cursor.etag, state)) return;
  }
}

/** The cursor and its etag; `etag` is null while no cursor exists yet. */
async function readCursor(env: Env, repo: string) {
  const stored = await env.OBJECTS.get(stateKey(repo));
  if (!stored) return { state: { ...EMPTY }, etag: null };
  return { state: await stored.json<ChangeLogState>(), etag: stored.etag };
}

/** Writes the cursor only if it is still the one read (or, with no etag, still absent);
 * returns the new etag, or null when another job moved it first. */
async function swapCursor(env: Env, repo: string, etag: string | null, state: ChangeLogState) {
  const onlyIf = etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' };
  const written = await env.OBJECTS.put(stateKey(repo), JSON.stringify(state), { onlyIf });
  return written ? written.etag : null;
}

/**
 * Sends every change record after the repository's cursor. Each range is claimed first
 * by a conditional cursor write, so concurrent jobs for one repository (a burst of
 * landings) send it once; a job that loses the claim stops. A failed send gives its
 * range back, keeping delivery at least once. The first job for a repository only records
 * the head, and a job that finds the stream stalled out only jumps to it. Never throws:
 * returns the cursor state, or null when no change-log stream is bound to this deployment.
 */
export async function emitChangeLog(env: Env, repo: string): Promise<ChangeLogState | null> {
  const stream = env.CHANGELOG;
  if (!stream) return null;
  let state: ChangeLogState = { ...EMPTY };
  let claimed: { from: ChangeLogState; count: number } | null = null;
  // The previous round's claim, sent: released in the next claim write or at the end.
  let confirmed: number | null = null;
  try {
    const call = caller(env, repo, { _system: 'derive' });
    for (let round = 0; round < ROUNDS; round++) {
      const cursor = await readCursor(env, repo);
      state = cursor.state;
      if (!cursor.etag || stalledOut(state)) {
        const head = await call({ op: 'repo_change_records', from_head: true });
        if (cursor.etag) return (await skipChangeLog(env, repo, head.version, 'age')) ?? state;
        const start = { ...EMPTY, version: head.version, ticket: head.ticket };
        return (await swapCursor(env, repo, null, start)) ? start : state;
      }
      const page = await call({
        op: 'repo_change_records',
        after_version: state.version,
        after_ticket: state.ticket,
      });
      const events = (page.records as Json[]).map((r) => changeEvent(repo, r));
      if (events.length === 0 && page.version === state.version && page.ticket === state.ticket)
        break;
      const next: ChangeLogState = {
        ...state,
        claims: { ...without(state.claims, confirmed ?? -1), [state.version]: Date.now() },
        version: page.version,
        ticket: page.ticket,
        sent: state.sent + events.length,
        ...(events.length > 0 ? { last_sent_at: new Date().toISOString() } : {}),
      };
      const etag = await swapCursor(env, repo, cursor.etag, next);
      if (!etag) return state; // another job claimed this range
      claimed = { from: state, count: events.length };
      for (const batch of sendBatches(events)) await stream.send(batch);
      claimed = null;
      confirmed = state.version;
      state = next;
      if (page.version >= page.head_version) break;
    }
    if (confirmed !== null) {
      await release(env, repo, confirmed);
      state = { ...state, claims: without(state.claims, confirmed) };
    }
  } catch (e: any) {
    const error = {
      code: e instanceof ApiError ? e.code : String(e?.code ?? 'CHANGELOG_SEND'),
      message: String(e?.message ?? e).slice(0, 200),
      at: new Date().toISOString(),
    };
    console.error(JSON.stringify({ event: 'changelog.emit_failed', repo, ...error }));
    state = await giveBack(env, repo, claimed, error).catch(() => state);
  }
  return state;
}

/**
 * Records a failure and, for a claimed range that was not sent and still is claimed, moves
 * the cursor back to the range's start (never forward). Later jobs then re-send it, and
 * anything claimed after it, which only costs duplicates that consumers dedupe on
 * `event_key`. A jump drops claims, so a range given up stays given up. With no cursor
 * nothing is written: a cursor made here would hold compaction at version 0.
 */
async function giveBack(
  env: Env,
  repo: string,
  claimed: { from: ChangeLogState; count: number } | null,
  error: NonNullable<ChangeLogState['last_error']>,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cursor = await readCursor(env, repo);
    if (!cursor.etag) return cursor.state;
    const from = claimed?.from;
    const held = from !== undefined && String(from.version) in (cursor.state.claims ?? {});
    const state: ChangeLogState = {
      ...cursor.state,
      claims: from ? without(cursor.state.claims, from.version) : cursor.state.claims,
      stalled_since: cursor.state.stalled_since ?? Date.now(),
      ...(claimed && from && held && from.version <= cursor.state.version
        ? {
            version: from.version,
            ticket: Math.min(from.ticket, cursor.state.ticket),
            sent: cursor.state.sent - claimed.count,
          }
        : {}),
      failures: cursor.state.failures + 1,
      last_error: error,
    };
    if (await swapCursor(env, repo, cursor.etag, state)) return state;
  }
  throw new Error('Change-log cursor is contended');
}

/** Emission counters for a repository's readers (`GET /repos/{id}/changelog`). */
export async function changeLogStatus(ctx: RepoContext) {
  await ctx.status(); // read access first
  return {
    enabled: Boolean(ctx.env.CHANGELOG),
    ...(await readState(ctx.env, ctx.repo)),
  };
}
