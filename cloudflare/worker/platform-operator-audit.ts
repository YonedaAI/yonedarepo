// The operator log (OPERATOR_AUDIT, D1 migration 0015): who did what from the admin pages, split
// into People and System so test cleanup and backfills leave what a person reads, with the request
// behind each row. It also records what never reached it: a caller refused at the door, an
// operator's action that failed, a purge's way to its end, and staff opening a customer's private
// repository. A failed write is logged and changes no answer. A row holds no token, secret, IP
// address or user agent. Budget: docs/load-testing.md.
import { afterAnswer } from './background';
import { log } from './log';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { currentScope, requestId } from './request-scope';
import type { Env } from './types';

export const operatorAudit = (env: Env) => env.OPERATOR_AUDIT === 'on';

const PAGE = 50;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SECTION = /^[a-z-]{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const OUTCOMES = new Set(['success', 'failed', 'denied', 'requested', 'queued', 'completed']);
/** Words a detail's key can't hold. A row is written by our own code; this is its seat belt. */
const SECRET = /token|secret|password|authorization|cookie|credential|signature|api_?key/i;
const SYSTEM_ACTION = /backfill|rebuild/;
const PURGES = "('repo.purge_now','repo.purge_orphan')";
/** A purge ends long after it was asked for, and no row should wait longer than this. */
const PURGE_MS = 30 * DAY_MS;
const DENIED_MS = 5 * 60_000;
const DENIED_MOST = 60;
const STAFF_MS = HOUR_MS;
const HELD_MOST = 1_000;

const actorKind = (actor: string, action: string) =>
  actor === '_admin' || SYSTEM_ACTION.test(action) ? 'system' : 'person';

/** Where the request came from, as far as it says: no address, ever. */
function requestContext() {
  const scope = currentScope();
  const req = scope?.req;
  const origin = req?.headers.get('origin');
  let host = origin ? null : 'script';
  try {
    if (origin) host = new URL(origin).hostname.toLowerCase();
  } catch {
    host = null;
  }
  const zone = (req?.cf as { timezone?: unknown } | undefined)?.timezone;
  return {
    request_id: requestId(scope) ?? null,
    origin: host && (host === 'script' || HOST.test(host)) ? host : null,
    time_zone: typeof zone === 'string' && ZONE.test(zone) ? zone : null,
  };
}

/** Writes a row with its request, answering its id. */
export async function auditRow(
  env: Env,
  actor: string,
  action: string,
  target: string,
  detail: Json | null,
  outcome: string,
) {
  const { request_id, origin, time_zone } = requestContext();
  const row = await env.INDEX.prepare(
    `INSERT INTO admin_audit(at,actor,action,target,detail,outcome,request_id,actor_kind,origin,time_zone)
       VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      Date.now(),
      actor,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
      outcome,
      request_id,
      actorKind(actor, action),
      origin,
      time_zone,
    )
    .first<{ id: number }>();
  if (!row) throw new ApiError('INTERNAL', 'The audit row was not written');
  return row.id;
}

/** What a finished action's detail says of how it went. */
export function outcomeOf(detail: Json) {
  if (typeof detail.outcome === 'string') return detail.outcome;
  if (detail.failed) return 'failed';
  return detail.queued ? 'queued' : 'success';
}

const writeLater = (work: () => Promise<unknown>) =>
  afterAnswer(work).catch((e) => log.warn('operator_audit.lost', { error: e }));

/** Once per key and `ms`, in this isolate, with the map kept to a size. */
function firstIn(seen: Map<string, number>, key: string, ms: number, now: number) {
  const last = seen.get(key);
  if (last !== undefined && now - last < ms) return false;
  if (seen.size >= HELD_MOST) seen.clear();
  seen.set(key, now);
  return true;
}

const callerName = (auth: Credentials) => {
  if ('_pat' in auth) return auth._pat.workspace;
  if ('_session' in auth) return auth._session.workspace;
  return '_token' in auth ? 'repository token' : 'unknown';
};

const denied = new Map<string, number>();
let deniedHour = { start: 0, count: 0 };
export function forgetAttempts() {
  denied.clear();
  staffReads.clear();
  deniedHour = { start: 0, count: 0 };
}

/** Someone who is no operator knocked on the admin API. Anyone signed in can do that, so it's
 * held to one row per caller every few minutes and a few an hour, per isolate. */
export function deniedAttempt(env: Env, auth: Credentials, section?: string, now = Date.now()) {
  if (!operatorAudit(env)) return;
  const who = callerName(auth);
  if (!firstIn(denied, who, DENIED_MS, now)) return;
  if (now - deniedHour.start >= HOUR_MS) deniedHour = { start: now, count: 0 };
  if (++deniedHour.count > DENIED_MOST) return;
  const target = section && SECTION.test(section) ? section : 'other';
  return writeLater(() => auditRow(env, who, 'admin.denied', target, null, 'denied'));
}

/** An operator's change that threw. A read that failed changed nothing, and says so itself. */
export function failedAttempt(env: Env, actor: string, method: string, parts: string[], e: any) {
  if (!operatorAudit(env) || method === 'GET' || method === 'HEAD') return;
  const [section, id, action] = parts;
  const detail = { section, action: action ?? null, code: String(e?.code ?? 'INTERNAL') };
  return writeLater(() => auditRow(env, actor, 'admin.failed', id ?? section, detail, 'failed'));
}

/** Runs a purge an operator asked for, recording that it was asked and that it was queued. */
export async function auditedPurge(
  env: Env,
  actor: string,
  repo: string,
  purge: () => Promise<unknown>,
) {
  const id = await auditRow(env, actor, 'repo.purge_now', repo, {}, 'requested');
  try {
    await purge();
  } catch (e: any) {
    await finishRow(env, id, { failed: e?.code ?? 'INTERNAL' });
    throw e;
  }
  await finishRow(env, id, { queued: true });
}

const finishRow = (env: Env, id: number, detail: Json) =>
  env.INDEX.prepare('UPDATE admin_audit SET detail=?,outcome=? WHERE id=?')
    .bind(JSON.stringify(detail), outcomeOf(detail), id)
    .run();

/** A purge job ended: the rows of operators who asked for it say how. A job that failed is sent
 * again, and its next run can still finish them. */
export async function settlePurge(env: Env, repo: string, outcome: 'completed' | 'failed') {
  if (!operatorAudit(env)) return;
  await env.INDEX.prepare(
    `UPDATE admin_audit SET outcome=? WHERE action IN ${PURGES} AND target=? AND at>=?
       AND outcome IN ('requested','queued','failed')`,
  )
    .bind(outcome, repo, Date.now() - PURGE_MS)
    .run()
    .catch((e) => log.warn('operator_audit.lost', { repo, error: e }));
}

const staffReads = new Map<string, number>();

/** A customer's private repository, and not one of ours: the only reads worth a row. */
async function isCustomers(env: Env, repo: string) {
  const row = await env.INDEX.prepare(
    `SELECT 1 AS yes FROM platform_repos WHERE id=? AND visibility<>'public'
       AND workspace NOT IN (SELECT account FROM platform_accounts WHERE internal=1)`,
  )
    .bind(repo)
    .first();
  return Boolean(row);
}

/** Staff opened a repository's records, the one way to a repository they aren't members of
 * (`asOwner`, platform-admin.ts). Once an hour per person and repository, per isolate. */
export function staffRead(env: Env, actor: string, repo: string, now = Date.now()) {
  if (!operatorAudit(env) || !firstIn(staffReads, `${actor}:${repo}`, STAFF_MS, now)) return;
  return writeLater(async () => {
    if (await isCustomers(env, repo))
      await auditRow(env, actor, 'repo.staff_read', repo, null, 'success');
  });
}

function clean(detail: unknown): unknown {
  if (Array.isArray(detail)) return detail.map(clean);
  if (!detail || typeof detail !== 'object') return detail;
  return Object.fromEntries(
    Object.entries(detail)
      .filter(([key]) => !SECRET.test(key))
      .map(([key, value]) => [key, clean(value)]),
  );
}

/** A LIKE prefix from a filter's value, wildcards escaped. */
const prefix = (value: string | null) => {
  const text = value?.trim().toLowerCase().slice(0, 100);
  return text ? `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
};
const dayStart = (value: string | null) => {
  const at = value && DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

const KIND = `COALESCE(actor_kind, CASE WHEN actor='_admin' OR action LIKE '%backfill%'
  OR action LIKE '%rebuild%' THEN 'system' ELSE 'person' END)`;

/** `GET audit?view=&actor=&action=&target=&outcome=&from=&to=&before=`, newest first. People's
 * rows unless `view=system`. `from` and `to` are days, `to` included. */
export async function operatorLog(env: Env, query: URLSearchParams) {
  const where = [`${KIND}=?`];
  const binds: unknown[] = [query.get('view') === 'system' ? 'system' : 'person'];
  const add = (sql: string, value: unknown) => {
    if (value === null || value === undefined) return;
    where.push(sql);
    binds.push(value);
  };
  add("lower(actor) LIKE ? ESCAPE '\\'", prefix(query.get('actor')));
  add("lower(action) LIKE ? ESCAPE '\\'", prefix(query.get('action')));
  add("lower(target) LIKE ? ESCAPE '\\'", prefix(query.get('target')));
  const outcome = query.get('outcome');
  if (outcome === 'success') where.push("COALESCE(outcome,'success')='success'");
  else if (outcome && OUTCOMES.has(outcome)) add('outcome=?', outcome);
  add('at>=?', dayStart(query.get('from')));
  const to = dayStart(query.get('to'));
  add('at<?', to === null ? null : to + DAY_MS);
  const before = Number(query.get('before'));
  add('at<?', Number.isSafeInteger(before) && before > 0 ? before : null);
  const { results } = await env.INDEX.prepare(
    `SELECT id,at,actor,action,target,detail,COALESCE(outcome,'success') AS outcome,request_id,
       ${KIND} AS actor_kind,origin,time_zone FROM admin_audit
       WHERE ${where.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<Json>();
  const rows = results.slice(0, PAGE);
  return {
    items: rows.map((r) => ({ ...r, detail: r.detail ? clean(JSON.parse(r.detail)) : null })),
    next: results.length > PAGE ? (rows.at(-1)?.at ?? null) : null,
    detailed: true,
  };
}
