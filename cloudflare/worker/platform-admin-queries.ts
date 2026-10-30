// The admin pages' reads of the D1 projections (operators only; platform-admin.ts checks): the
// overview's totals, the account and repository listings, the sign-up feed and the audit
// log. Listings page backwards by creation time (`before`, a millisecond time).
import type { Env, Json } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PAGE = 50;

/** A positive millisecond time from a query value, else undefined. */
export function timeParam(value: string | null): number | undefined {
  const n = Number(value);
  return value && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
/** A search term for LIKE (wildcards escaped), or undefined. */
function likeParam(value: string | null) {
  const q = value?.trim().toLowerCase().slice(0, 100);
  return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
}

const count = async (env: Env, sql: string, ...binds: unknown[]) =>
  (
    await env.INDEX.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

/** `GET overview`. */
export async function overview(env: Env, now = Date.now()) {
  const since = (days: number) => now - days * DAY_MS;
  const [accounts, day, week, month, active, suspended, repos, perDay] = await Promise.all([
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts'),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE created_at>=?', since(1)),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE created_at>=?', since(7)),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE created_at>=?', since(30)),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE last_seen_at>=?', since(7)),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE suspended_at IS NOT NULL'),
    env.INDEX.prepare(
      'SELECT visibility,COUNT(*) AS n FROM platform_repos GROUP BY visibility',
    ).all<{ visibility: string; n: number }>(),
    // Integer days: a bound divisor would be a REAL in D1, and its quotient fractional.
    env.INDEX.prepare(
      `SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS day,COUNT(*) AS n FROM platform_accounts
        WHERE created_at>=? GROUP BY day`,
    )
      .bind(since(29) - (since(29) % DAY_MS))
      .all<{ day: number; n: number }>(),
  ]);
  const byDay = new Map(perDay.results.map((r) => [r.day, r.n]));
  const today = Math.floor(now / DAY_MS);
  const visible = (v: string) => repos.results.find((r) => r.visibility === v)?.n ?? 0;
  return {
    accounts: { total: accounts, new_24h: day, new_7d: week, new_30d: month, active_7d: active },
    suspended,
    repos: { public: visible('public'), private: visible('private') },
    signups_per_day: Array.from({ length: 30 }, (_, i) => {
      const at = today - 29 + i;
      return { day: new Date(at * DAY_MS).toISOString().slice(0, 10), count: byDay.get(at) ?? 0 };
    }),
  };
}

const ACCOUNT_COLUMNS = `a.account,a.created_at,a.provider,COALESCE(h.handle,a.handle) AS handle,
  a.email_named,a.suspended_at,a.last_seen_at,
  (SELECT COUNT(*) FROM platform_repos r WHERE r.workspace=a.account) AS repos`;

/** `GET accounts?q=&before=`: newest first; `q` matches the name or handle. */
export async function listAccounts(env: Env, q: string | null, before: string | null) {
  const like = likeParam(q);
  const until = timeParam(before);
  const where = [
    ...(like ? ["(a.account LIKE ? ESCAPE '\\' OR h.handle LIKE ? ESCAPE '\\')"] : []),
    ...(until ? ['a.created_at<?'] : []),
  ];
  const { results } = await env.INDEX.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts a
       LEFT JOIN platform_handles h ON h.workspace=a.account
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC,a.account LIMIT ?`,
  )
    .bind(...(like ? [like, like] : []), ...(until ? [until] : []), PAGE + 1)
    .all<Json>();
  return page(results.map(accountRow));
}

/** One account's row, or null when the index has none. */
export async function accountRowOf(env: Env, account: string) {
  const row = await env.INDEX.prepare(
    `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts a
       LEFT JOIN platform_handles h ON h.workspace=a.account WHERE a.account=?`,
  )
    .bind(account)
    .first<Json>();
  return row ? accountRow(row) : null;
}

const accountRow = (r: Json) => ({
  account: r.account,
  handle: r.handle ?? null,
  provider: r.provider,
  created_at: r.created_at,
  last_seen_at: r.last_seen_at ?? null,
  repos: r.repos ?? 0,
  suspended: r.suspended_at !== null && r.suspended_at !== undefined,
  suspended_at: r.suspended_at ?? null,
});

/** One page and the `before` cursor of the next (null after the last). */
function page<T extends { created_at: number }>(rows: T[]) {
  const items = rows.slice(0, PAGE);
  return { items, next: rows.length > PAGE ? (items.at(-1)?.created_at ?? null) : null };
}

const REPO_COLUMNS = `r.id,r.name,r.workspace AS owner,COALESCE(h.handle,
  CASE WHEN instr(r.workspace,'@')=0 THEN r.workspace END) AS handle,r.visibility,r.created_at`;

/** `GET repos?q=&before=` (or one owner's, for an account's detail). */
export async function listRepos(env: Env, q: string | null, before: string | null, owner?: string) {
  const like = likeParam(q);
  const until = timeParam(before);
  const where = [
    ...(owner ? ['r.workspace=?'] : []),
    ...(like ? ["(r.name LIKE ? ESCAPE '\\' OR r.workspace LIKE ? ESCAPE '\\')"] : []),
    ...(until ? ['r.created_at<?'] : []),
  ];
  const { results } = await env.INDEX.prepare(
    `SELECT ${REPO_COLUMNS} FROM platform_repos r
       LEFT JOIN platform_handles h ON h.workspace=r.workspace
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at DESC,r.id LIMIT ?`,
  )
    .bind(
      ...(owner ? [owner] : []),
      ...(like ? [like, like] : []),
      ...(until ? [until] : []),
      PAGE + 1,
    )
    .all<{ created_at: number }>();
  return page(results);
}

/** One repository's listing row (its owner, for acting as the owner), or null. */
export const repoRowOf = (env: Env, repo: string) =>
  env.INDEX.prepare(
    `SELECT ${REPO_COLUMNS} FROM platform_repos r
       LEFT JOIN platform_handles h ON h.workspace=r.workspace WHERE r.id=?`,
  )
    .bind(repo)
    .first<Json>();

/** `GET signups?since=`: the newest sign-ups, and how many came after `since` (the
 * operator's last look, kept by the browser). */
export async function signups(env: Env, since: string | null) {
  const after = timeParam(since) ?? 0;
  const [{ results }, unread] = await Promise.all([
    env.INDEX.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts a
         LEFT JOIN platform_handles h ON h.workspace=a.account
         ORDER BY a.created_at DESC,a.account LIMIT ?`,
    )
      .bind(PAGE)
      .all<Json>(),
    count(env, 'SELECT COUNT(*) AS n FROM platform_accounts WHERE created_at>?', after),
  ]);
  return { items: results.map(accountRow), unread };
}

/** `GET audit?before=`: operator actions, newest first. */
export async function auditLog(env: Env, before: string | null) {
  const until = timeParam(before);
  const { results } = await env.INDEX.prepare(
    `SELECT id,at,actor,action,target,detail FROM admin_audit
       ${until ? 'WHERE at<?' : ''} ORDER BY at DESC,id DESC LIMIT ?`,
  )
    .bind(...(until ? [until] : []), PAGE + 1)
    .all<Json>();
  const rows = results.map((r) => ({
    ...r,
    created_at: r.at,
    detail: r.detail ? JSON.parse(r.detail) : null,
  }));
  const { items, next } = page(rows);
  return { items: items.map(({ created_at: _, ...r }) => r), next };
}

/** Records an operator action (every admin POST). */
export async function audit(
  env: Env,
  actor: string,
  action: string,
  target: string,
  detail: Json | null = null,
) {
  await env.INDEX.prepare(
    'INSERT INTO admin_audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)',
  )
    .bind(Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null)
    .run();
}
