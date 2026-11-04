// Sorted operator-only D1 listing. Each cell uses the same keyset fence, then bounded
// pages merge globally. No repository authority/storage requests run on this path.
import { normalizeAccountIdentifier } from '../../shared/account';
import type {
  RepositoryFilters,
  RepositoryListing,
  RepositoryOrder,
  RepositoryPage,
} from '../../shared/admin-repositories';
import { cellsOn, FIRST_CELL, thisCell } from './cells';
import { ApiError } from './repo-ops';
import { storageLevel } from './repo-storage';
import type { Env } from './types';

const PAGE = 50;
const COLUMNS = {
  name: 'lower(r.name)',
  owner: 'lower(COALESCE(inherited.handle,h.handle,r.workspace))',
  visibility: 'r.visibility',
  created: 'r.created_at',
  database: 'a.db_bytes',
} as const;
type Cursor = RepositoryOrder &
  Partial<RepositoryFilters> & {
    q: string;
    value: string | number | null;
    id: string;
  };
export type RepositoryQuery = RepositoryOrder & RepositoryFilters & { q: string; cursor?: Cursor };
const invalid = () => new ApiError('INVALID_INPUT', 'The repository order changed. Search again.');

export function repositoryQuery(query: URLSearchParams): RepositoryQuery {
  const allowed = new Set(['sort', 'direction', 'q', 'cursor', 'owner', 'visibility']);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw invalid();
  const rawOwner = (query.get('owner') ?? '').trim();
  const owner = rawOwner ? normalizeAccountIdentifier(rawOwner.replace(/^@/, '')) : '';
  if (owner === null) throw new ApiError('INVALID_INPUT', 'Enter an exact owner handle or email.');
  const visibility = query.get('visibility') ?? '';
  if (!['', 'public', 'private'].includes(visibility))
    throw new ApiError('INVALID_INPUT', 'Choose public or private visibility.');
  const sort = query.get('sort') ?? 'database';
  const direction = query.get('direction') ?? 'desc';
  if (!Object.hasOwn(COLUMNS, sort) || !['asc', 'desc'].includes(direction)) throw invalid();
  const order = {
    sort,
    direction,
    q: (query.get('q') ?? '').trim().toLowerCase().slice(0, 100),
    owner,
    visibility,
  } as RepositoryQuery;
  const raw = query.get('cursor');
  if (raw !== null) {
    if (raw.length > 1000) throw invalid();
    let cursor: Cursor;
    try {
      cursor = JSON.parse(raw);
    } catch {
      throw invalid();
    }
    const numeric = sort === 'created' || sort === 'database';
    if (
      !cursor ||
      cursor.sort !== sort ||
      cursor.direction !== direction ||
      cursor.q !== order.q ||
      (cursor.owner ?? '') !== order.owner ||
      (cursor.visibility ?? '') !== order.visibility ||
      typeof cursor.id !== 'string' ||
      !/^r[0-9a-f]{20}$/.test(cursor.id) ||
      !(cursor.value === null
        ? sort === 'database'
        : numeric
          ? Number.isSafeInteger(cursor.value) && Number(cursor.value) >= 0
          : typeof cursor.value === 'string' && cursor.value.length <= 320)
    )
      throw invalid();
    order.cursor = cursor;
  }
  return order;
}
const cursorOf = (q: RepositoryQuery, row: RepositoryListing) =>
  JSON.stringify({
    sort: q.sort,
    direction: q.direction,
    q: q.q,
    ...(q.owner ? { owner: q.owner } : {}),
    ...(q.visibility ? { visibility: q.visibility } : {}),
    value: row.sort_value,
    id: row.id,
  });

/** SQLite BINARY ordering compares UTF-8 bytes; use the same ordering when merging cells. */
function textOrder(a: string, b: string) {
  const aa = new TextEncoder().encode(a),
    bb = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++)
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
export function mergeRepositoryPages(parts: RepositoryPage[], q: RepositoryQuery): RepositoryPage {
  const rows = parts
    .flatMap((part) => part.items)
    .sort((a, b) => {
      const av = a.sort_value,
        bv = b.sort_value;
      const order =
        av === null
          ? bv === null
            ? 0
            : 1
          : bv === null
            ? -1
            : (typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : textOrder(String(av), String(bv))) * (q.direction === 'asc' ? 1 : -1);
      return order || textOrder(a.id, b.id);
    });
  const items = rows.slice(0, PAGE);
  const more = rows.length > PAGE || parts.some((part) => part.next !== null);
  return { items, next: more && items.length ? cursorOf(q, items[items.length - 1]) : null };
}

// Legacy email-named accounts predate cells; their handle projection lives in the
// default directory even when they own a repository elsewhere (see handlesOf).
// Resolve a bounded cohort before WHERE/ORDER/LIMIT, rather than fixing display
// handles after paging and silently searching/sorting the wrong owner values.
const LEGACY_OWNERS = 500;
async function inheritedHandles(env: Env) {
  if (!cellsOn(env) || thisCell(env) === FIRST_CELL) return '[]';
  const { results: owners } = await env.INDEX.prepare(
    `SELECT DISTINCT r.workspace,h.handle FROM platform_repos r
       LEFT JOIN platform_handles h ON h.workspace=r.workspace
       WHERE instr(r.workspace,'@')>0 ORDER BY r.workspace LIMIT ?`,
  )
    .bind(LEGACY_OWNERS + 1)
    .all<{ workspace: string; handle: string | null }>();
  if (owners.length > LEGACY_OWNERS)
    throw new ApiError(
      'CELL_UNAVAILABLE',
      'The repository owner directory could not be read completely',
    );
  // Match handlesOf: any missing local alias activates home-first fallback for the
  // whole cohort, including stale local aliases, rather than only filling holes.
  if (owners.every((owner) => owner.handle !== null)) return '[]';
  if (!env.INDEX_ENAM)
    throw new ApiError('CELL_UNAVAILABLE', 'The repository owner directory is unavailable');
  const { results } = await env.INDEX_ENAM.prepare(
    'SELECT workspace,handle FROM platform_handles WHERE workspace IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify(owners.map((owner) => owner.workspace)))
    .all<{ workspace: string; handle: string }>();
  return JSON.stringify(results);
}

export async function sortedRepositories(env: Env, q: RepositoryQuery): Promise<RepositoryPage> {
  const binds: unknown[] = [await inheritedHandles(env)];
  const where: string[] = [];
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      "(r.name LIKE ? ESCAPE '\\' OR r.workspace LIKE ? ESCAPE '\\' OR COALESCE(inherited.handle,h.handle) LIKE ? ESCAPE '\\' OR r.id LIKE ? ESCAPE '\\')",
    );
    binds.push(like, like, like, like);
  }
  if (q.owner) {
    where.push('(lower(r.workspace)=? OR lower(COALESCE(inherited.handle,h.handle))=?)');
    binds.push(q.owner, q.owner);
  }
  if (q.visibility) {
    where.push('r.visibility=?');
    binds.push(q.visibility);
  }
  let fence = '';
  if (q.cursor) {
    const { value, id } = q.cursor;
    if (value === null) {
      fence = 'WHERE sort_value IS NULL AND id>?';
      binds.push(id);
    } else {
      fence = `WHERE sort_value IS NULL OR sort_value ${q.direction === 'asc' ? '>' : '<'} ? OR (sort_value=? AND id>?)`;
      binds.push(value, value, id);
    }
  }
  const { results } = await env.INDEX.prepare(
    `WITH inherited AS (SELECT json_extract(value,'$.workspace') AS workspace,
       json_extract(value,'$.handle') AS handle FROM json_each(?)),
     matching AS (SELECT r.id,r.name,r.workspace AS owner,
       COALESCE(inherited.handle,h.handle,CASE WHEN instr(r.workspace,'@')=0 THEN r.workspace END) AS handle,
       r.visibility,r.created_at,a.db_bytes,${COLUMNS[q.sort]} AS sort_value
       FROM platform_repos r LEFT JOIN platform_handles h ON h.workspace=r.workspace
       LEFT JOIN inherited ON inherited.workspace=r.workspace
       LEFT JOIN platform_activity a ON a.repo=r.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
     SELECT * FROM matching ${fence}
       ORDER BY sort_value IS NULL ASC,sort_value ${q.direction.toUpperCase()},id ASC LIMIT ?`,
  )
    .bind(...binds, PAGE + 1)
    .all<Omit<RepositoryListing, 'level'>>();
  const rows = results.map((r) => ({
    ...r,
    level: r.db_bytes === null ? null : storageLevel(r.db_bytes),
  }));
  const items = rows.slice(0, PAGE);
  return { items, next: rows.length > PAGE ? cursorOf(q, items[items.length - 1]) : null };
}
