// Change-log analytics: after landing, the derive job streams the authority's change
// records to a Basin Pipeline (Iceberg table, queried with Basin SQL). It is never on the
// commit path: emission is best effort, resumes from a per-repository cursor in R2, and is
// at least once, so consumers dedupe on `event_key` (repository + version or ticket). A
// failure is counted and logged and never fails the job or a landing.
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

/** Rounds per job (each reads up to 100 versions); the next landing's job continues. */
const ROUNDS = 10;

export type ChangeEvent = Record<string, string | number | string[]>;
export type ChangeLogState = {
  version: number;
  ticket: number;
  sent: number;
  failures: number;
  last_sent_at?: string;
  last_error?: { code: string; message: string; at: string };
};

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

async function readState(env: Env, repo: string): Promise<ChangeLogState> {
  const stored = await env.OBJECTS.get(stateKey(repo));
  return stored
    ? await stored.json<ChangeLogState>()
    : { version: 0, ticket: 0, sent: 0, failures: 0 };
}

/**
 * Sends every change record after the repository's cursor. Never throws: returns the new
 * state, or null when no change-log stream is bound to this deployment.
 */
export async function emitChangeLog(env: Env, repo: string): Promise<ChangeLogState | null> {
  const stream = env.CHANGELOG;
  if (!stream) return null;
  let state: ChangeLogState = { version: 0, ticket: 0, sent: 0, failures: 0 };
  try {
    state = await readState(env, repo);
    const call = caller(env, repo, { _system: 'derive' });
    for (let round = 0; round < ROUNDS; round++) {
      const page = await call({
        op: 'repo_change_records',
        after_version: state.version,
        after_ticket: state.ticket,
      });
      const events = (page.records as Json[]).map((r) => changeEvent(repo, r));
      if (events.length > 0) {
        await stream.send(events);
        state.sent += events.length;
        state.last_sent_at = new Date().toISOString();
      }
      state.version = page.version;
      state.ticket = page.ticket;
      if (page.version >= page.head_version) break;
    }
  } catch (e: any) {
    state.failures++;
    state.last_error = {
      code: e instanceof ApiError ? e.code : String(e?.code ?? 'CHANGELOG_SEND'),
      message: String(e?.message ?? e).slice(0, 200),
      at: new Date().toISOString(),
    };
    console.error(JSON.stringify({ event: 'changelog.emit_failed', repo, ...state.last_error }));
  }
  // Progress made before a failure is kept; the cursor write is itself best effort.
  await env.OBJECTS.put(stateKey(repo), JSON.stringify(state)).catch(() => {});
  return state;
}

/** Emission counters for a repository's readers (`GET /repos/{id}/changelog`). */
export async function changeLogStatus(ctx: RepoContext) {
  await ctx.status(); // read access first
  return {
    enabled: Boolean(ctx.env.CHANGELOG),
    ...(await readState(ctx.env, ctx.repo)),
  };
}
