// `GET /api/v1/search`: a search across the caller's repositories, behind ACCOUNT_SEARCH. A
// filter, not an index. The listing and its limits are `GET /repos`'s (reachOf, a token's
// allowlist and org); the search directory then says which repositories can't match; and each
// that can is asked through its own `/repos/:id/search`, with the caller's own credentials, so
// its visibility, members, quarantine and access bound decide what comes back. The directory's
// answer is never returned, so only repositories that found something are named.
//
// Budget (docs/global-scale-plan.md): 25 repositories' code per page, the newest that can
// match, 4 at a time, and the newest 25 repositories' records on the first page, since records
// have no summary. Page time is bounded, and `next` continues from the last repository started.
import { reachOf } from './repo-admin';
import { SEARCH_GROUPS } from './repo-derived';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { withPaths } from './repo-paths';
import { accountSearchOn } from './repo-search-directory';
import type { Env } from './types';
import { searchDirectory } from './workspace';

/** The REST router (`repo-api.ts`), so each repository is asked by its own route. */
type Route = (req: Request, env: Env, url: URL, auth: Credentials) => Promise<Json>;

const PAGE_REPOS = 25;
const AT_ONCE = 4;
const PAGE_MS = 20_000;
/** Repositories one listing statement reads, and statements per page. */
const LIST_REPOS = 200;
const LIST_PAGES = 5;
/** Directories asked per page, and how long each may take: past either, "maybe". */
const DIRECTORIES = 16;
const DIRECTORY_MS = 2_000;
/** The shortest query with a trigram; a shorter one can't be filtered. */
const TRIGRAM = 3;

/** What each repository's search refuses a caller the listing let through (a projection can
 * lag), or has nothing for (no main yet). */
const REFUSED = ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'GONE'];
const CURSOR = /^(\d{1,16})\.(r[0-9a-f]{20})$/;

type Listed = {
  id: string;
  name: string;
  owner: string;
  created_at: number;
  visibility: string;
  /** Its newest known activity, 0 when none is recorded. */
  touched_at: number;
  /** What the listing sorts by. */
  active_at: number;
};
type Cursor = { at: number; id: string };
type Task = { row: Listed; groups: string[] };

const cursorOf = ({ active_at, id }: Listed) => `${active_at}.${id}`;

function parseCursor(after: string | null): Cursor | null {
  if (!after) return null;
  const parsed = CURSOR.exec(after);
  if (!parsed) throw new ApiError('INVALID_INPUT', 'after must be a value from next');
  return { at: Number(parsed[1]), id: parsed[2] };
}

/** One listing statement, newest activity first, past `after`. Filters are in the statement so
 * that a page is full of what the caller may search. Each list is one JSON parameter, as in
 * `GET /repos`. */
async function list(env: Env, auth: Credentials, after: Cursor | null, limit: number) {
  const { owners, entries } = reachOf(auth);
  const allowed = '_pat' in auth ? auth._pat.repos : null;
  const org = '_pat' in auth ? auth._pat.org : null;
  const { results } = await env.INDEX.prepare(
    `SELECT * FROM (
       SELECT r.id,r.name,r.workspace AS owner,r.created_at,r.visibility,
         COALESCE(a.touched_at,0) AS touched_at,
         MAX(r.created_at,COALESCE(a.touched_at,0)) AS active_at
       FROM platform_repos r LEFT JOIN platform_activity a ON a.repo=r.id
       WHERE (r.workspace IN (SELECT value FROM json_each(?1))
              OR r.id IN (SELECT repo FROM platform_members
                          WHERE account IN (SELECT value FROM json_each(?2))))
         AND (?3 IS NULL OR r.id IN (SELECT value FROM json_each(?3)))
         AND (?4 IS NULL OR r.workspace=?4))
     WHERE ?5 IS NULL OR active_at<?5 OR (active_at=?5 AND id<?6)
     ORDER BY active_at DESC,id DESC LIMIT ?7`,
  )
    .bind(
      JSON.stringify(owners),
      JSON.stringify(entries),
      allowed ? JSON.stringify(allowed) : null,
      org,
      after?.at ?? null,
      after?.id ?? null,
      limit,
    )
    .all<Listed>();
  return results;
}

/** One owner's repositories that may hold `query`: all of them, unless its directory answers
 * in time. */
async function askDirectory(env: Env, owner: string, rows: Listed[], query: string) {
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('directory timed out')), DIRECTORY_MS);
  });
  const repos = rows.map((r) => ({ id: r.id, at: r.touched_at }));
  try {
    const asked = searchDirectory(env, owner, { op: 'search_match', query, repos });
    return (await Promise.race([asked, late])).maybe as string[];
  } catch (e: any) {
    console.warn(`search directory: ${e?.message ?? e}`);
    return rows.map((r) => r.id);
  } finally {
    clearTimeout(timer);
  }
}

/** Which of `rows` may hold `query`; `budget.calls` limits the directories asked. */
async function filtered(env: Env, rows: Listed[], query: string, budget: { calls: number }) {
  if (query.length < TRIGRAM) return new Set(rows.map((r) => r.id));
  const byOwner = new Map<string, Listed[]>();
  for (const row of rows) byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row]);
  // The owners with the most repositories first: past the budget, the rest are "maybe".
  const owners = [...byOwner].sort(([, a], [, b]) => b.length - a.length);
  const answers = await Promise.all(
    owners.map(async ([owner, repos]) =>
      budget.calls-- > 0 ? askDirectory(env, owner, repos, query) : repos.map((r) => r.id),
    ),
  );
  return new Set(answers.flat());
}

/** The page's repositories: the first PAGE_REPOS that may hold `query`, past `after`; on the
 * first page also the newest PAGE_REPOS, whose records no filter can speak for. */
async function choose(
  env: Env,
  auth: Credentials,
  query: string,
  groups: string[],
  after: Cursor | null,
) {
  const code = groups.includes('code');
  const records = after ? [] : groups.filter((g) => g !== 'code');
  const tasks = new Map<string, Task>();
  const add = (row: Listed, asked: string[]) => {
    const task = tasks.get(row.id);
    if (task) task.groups.push(...asked);
    else tasks.set(row.id, { row, groups: [...asked] });
  };
  const budget = { calls: DIRECTORIES };
  let position = after;
  let last: Listed | undefined;
  let scanned = 0;
  let candidates = 0;
  let more = false;
  for (let page = 0; page < LIST_PAGES; page++) {
    const rows = await list(env, auth, position, code ? LIST_REPOS : PAGE_REPOS);
    if (scanned < PAGE_REPOS && records.length)
      for (const row of rows.slice(0, PAGE_REPOS - scanned)) add(row, records);
    const maybe = code ? await filtered(env, rows, query, budget) : new Set<string>();
    let stopped = false;
    for (const [index, row] of rows.entries()) {
      last = row;
      scanned++;
      if (!maybe.has(row.id)) continue;
      add(row, ['code']);
      if (++candidates === PAGE_REPOS) {
        more = index < rows.length - 1 || rows.length === LIST_REPOS;
        stopped = true;
        break;
      }
    }
    if (stopped || !code) break;
    more = rows.length === LIST_REPOS;
    if (!more) break;
    position = { at: Number(last?.active_at), id: String(last?.id) };
  }
  const ordered = [...tasks.values()].sort(
    (a, b) =>
      b.row.active_at - a.row.active_at || (b.row.id < a.row.id ? -1 : b.row.id > a.row.id ? 1 : 0),
  );
  return { tasks: ordered, scanned, next: more && last ? cursorOf(last) : null };
}

const foundNothing = (answer: Json) =>
  answer.results.length === 0 &&
  !answer.memories?.length &&
  !answer.commits?.count &&
  !answer.sessions?.count &&
  !answer.changes?.count;

type Outcome = { row: Listed; answer?: Json; error?: string };

/** One repository through its own route, with the caller's credentials. */
async function ask(
  env: Env,
  auth: Credentials,
  route: Route,
  origin: string,
  { row, groups }: Task,
  search: URLSearchParams,
): Promise<Outcome | null> {
  const url = new URL(`/api/v1/repos/${row.id}/search`, origin);
  for (const [key, value] of search) url.searchParams.set(key, value);
  url.searchParams.set('groups', groups.join(','));
  try {
    const answer = await route(new Request(url), env, url, auth);
    return foundNothing(answer) ? null : { row, answer };
  } catch (e: any) {
    if (REFUSED.includes(e?.code)) return null;
    return { row, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Runs `tasks` in order, AT_ONCE at a time, for at most `limit` ms: none starts after that,
 * and one still running is reported as failed. Answers how many started. */
export async function runAll(
  tasks: Task[],
  run: (task: Task) => Promise<Outcome | null>,
  limit = PAGE_MS,
) {
  const outcomes: (Outcome | null | undefined)[] = new Array(tasks.length);
  const deadline = Date.now() + limit;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && Date.now() < deadline) {
      const index = next++;
      outcomes[index] = await run(tasks[index]);
    }
  };
  let timer = 0;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limit);
  });
  await Promise.race([Promise.all(Array.from({ length: AT_ONCE }, worker)), expired]);
  clearTimeout(timer);
  const started = next;
  const settled = tasks
    .slice(0, started)
    .map(
      ({ row }, index) =>
        (outcomes[index] === undefined
          ? { row, error: 'This repository took too long to search' }
          : outcomes[index]) as Outcome | null,
    );
  return { settled, started };
}

export async function accountSearch(
  env: Env,
  auth: Credentials,
  url: URL,
  route: Route,
): Promise<Json> {
  if (!accountSearchOn(env)) throw new ApiError('NOT_FOUND', 'Unknown API path');
  // A repository token, path-restricted or not, is refused here: it has no account to list.
  reachOf(auth);
  const params = url.searchParams;
  const query = params.get('query') ?? params.get('q') ?? '';
  if (query.length < 2 || query.length > 200)
    throw new ApiError('INVALID_INPUT', 'query must be 2-200 characters');
  const groups = params.get('groups')?.split(',') ?? [...SEARCH_GROUPS];
  if (groups.length === 0 || groups.some((g) => !(SEARCH_GROUPS as readonly string[]).includes(g)))
    throw new ApiError('INVALID_INPUT', `groups lists ${SEARCH_GROUPS.join(', ')}`);
  const { tasks, scanned, next } = await choose(
    env,
    auth,
    query,
    groups,
    parseCursor(params.get('after')),
  );
  const search = new URLSearchParams({ query });
  for (const key of ['ignore_case', 'word', 'limit', 'path']) {
    const value = params.get(key);
    if (value !== null) search.set(key, value);
  }
  const { settled, started } = await runAll(tasks, (task) =>
    ask(env, auth, route, url.origin, task, search),
  );
  const outcomes = settled.filter((o): o is Outcome => o !== null);
  const named = await withPaths(
    env,
    outcomes.map((o) => o.row),
  );
  const row = (i: number) => ({
    repo: named[i].id,
    name: named[i].name,
    owner: named[i].owner_handle,
    path: named[i].path,
  });
  const shown = outcomes.map((outcome, i) => ({ ...row(i), ...outcome }));
  return {
    query,
    groups,
    results: shown.filter((o) => o.answer).map(({ row: _, error: __, ...found }) => found),
    failed: shown.filter((o) => o.error).map(({ row: _, answer: __, ...failed }) => failed),
    searched: settled.length,
    scanned,
    next: started < tasks.length ? cursorOf(tasks[started - 1].row) : next,
  };
}
