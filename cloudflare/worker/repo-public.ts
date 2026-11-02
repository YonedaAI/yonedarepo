// Public repositories, the adapter half (the rules are the authority's: repo_store/
// visibility.rs). A request without credentials is anonymous (`{_anonymous: true}`) where
// it may read: GETs of one repository's API, smart-HTTP fetches and LFS downloads, and the
// public listing. The authority admits it on a public repository and answers NOT_FOUND on
// a private one. Before anything of a repository wakes for an anonymous request, the
// discovery index must list it as public (`admitAnonymous`). Anonymous requests are rate
// limited per client address, and the costly reads (search, blame) more tightly and with
// smaller results. Visibility changes update the
// discovery listing on the side that never lists a private repository, and republish main's
// head before answering, so a repository made private stops serving anonymous reads
// everywhere within ACCESS_MS.
import { mergeListed } from './cell-merge';
import { acrossCells, askedHere } from './cell-route';
import { allCells, cellsOn, thisCell } from './cells';
import { audited } from './repo-audit';
import { refreshHead } from './repo-head';
import { ApiError, type Credentials, type Json, type RepoContext } from './repo-ops';
import { withPaths } from './repo-paths';
import { voidSummary } from './repo-search-directory';
import { currentScope } from './request-scope';
import type { Env } from './types';

export const ANONYMOUS: Credentials = { _anonymous: true };

const REPO_READ = /^\/api\/v1\/repos\/r[0-9a-f]{20}(?:\/|$)/;
const REPO_ID = /^\/api\/v1\/repos\/(r[0-9a-f]{20})(?:\/|$)/;
/** Reads whose cost grows with the repository: limited per address on their own. */
const COSTLY = /^\/api\/v1\/repos\/r[0-9a-f]{20}\/(?:search|blame)$/;
/** Most results a costly anonymous read returns. */
const ANONYMOUS_LIMIT = 20;
const EXPLORE_LIMIT = 100;

export const isExplore = (url: URL) => url.pathname === '/api/v1/explore';

/** The one read that is a POST: objects by id (the `yoneda::` helper's fetch). */
const OBJECTS = /^\/api\/v1\/repos\/r[0-9a-f]{20}\/objects$/;

/** Whether a request without credentials may go on as anonymous (MCP never does). */
export function anonymousRead(req: Request, url: URL): boolean {
  if (req.method === 'POST') return OBJECTS.test(url.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return isExplore(url) || (REPO_READ.test(url.pathname) && !url.pathname.endsWith('/mcp'));
}

/** Refuses an anonymous request for a repository the discovery index does not list as
 * public, before any of the repository's objects (authority, head holder) wakes: private
 * and unknown repositories get the authority's own NOT_FOUND, so neither is told apart.
 * The index only lags towards private (see `setVisibility`; rows are written once the
 * authority accepted a repository), so this can hide a public repository for a moment but
 * never admits a private one; the authority still decides every request it lets through. */
export async function admitAnonymous(env: Env, repo: string) {
  const row = await env.INDEX.prepare('SELECT visibility FROM platform_repos WHERE id=?')
    .bind(repo)
    .first<{ visibility: string }>();
  if (row?.visibility !== 'public') throw new ApiError('NOT_FOUND', 'Repository not found');
}

/** The repository an anonymous API read addresses (`anonymousRead` admits only these and
 * the public listing). */
export const anonymousRepo = (url: URL) => REPO_ID.exec(url.pathname)?.[1] ?? null;

/** Refuses an anonymous request over its address's budget: every read counts against
 * PUBLIC_LIMITER, and search and blame against the sign-in limiter's tighter one too. */
export async function limitAnonymous(env: Env, req: Request, pathname: string) {
  const address = req.headers.get('cf-connecting-ip') ?? 'local';
  const over = async (limiter: RateLimit | undefined, key: string) =>
    limiter ? !(await limiter.limit({ key })).success : false;
  if (
    (await over(env.PUBLIC_LIMITER, `public:${address}`)) ||
    (COSTLY.test(pathname) && (await over(env.AUTH_LIMITER, `public-costly:${address}`)))
  )
    throw new ApiError('RATE_LIMITED', 'Too many requests without signing in; wait or sign in');
}

/** A costly read's query, capped for an anonymous caller. */
export function capped(auth: Credentials, query: Json): Json {
  if (!('_anonymous' in auth)) return query;
  const limit = Math.min(
    Number(query.limit ?? ANONYMOUS_LIMIT) || ANONYMOUS_LIMIT,
    ANONYMOUS_LIMIT,
  );
  return { ...query, limit: String(limit) };
}

const VISIBILITIES = ['private', 'public'];

export function visibilityOf(value: unknown): 'private' | 'public' {
  if (value === undefined || value === null) return 'private';
  if (typeof value !== 'string' || !VISIBILITIES.includes(value))
    throw new ApiError('INVALID_INPUT', 'visibility must be private or public');
  return value as 'private' | 'public';
}

const listVisibility = (env: Env, repo: string, visibility: string) =>
  env.INDEX.prepare('UPDATE platform_repos SET visibility=? WHERE id=?')
    .bind(visibility, repo)
    .run();

/** `PUT /repos/:id/visibility {visibility}`: the owner's account only (the authority
 * decides). Made private: unlisted first, so discovery never names a private repository;
 * made public: listed once the authority agreed. */
export async function setVisibility(ctx: RepoContext, body: Json) {
  const visibility = visibilityOf(body.visibility);
  // Only the owner's account touches the listing (a stranger is told NOT_FOUND here); the
  // authority decides again below.
  const { viewer } = await ctx.status();
  if (!viewer?.owner || viewer.role)
    throw new ApiError('FORBIDDEN', 'Only the repository owner can do this');
  if (visibility === 'private') await listVisibility(ctx.env, ctx.repo, visibility);
  const changed = await audited(
    ctx.env,
    ctx.repo,
    ctx.call({ op: 'repo_set_visibility', visibility }),
  );
  await refreshHead(ctx.env, ctx.repo, true);
  if (visibility === 'public') await listVisibility(ctx.env, ctx.repo, visibility);
  await voidSummary(ctx.env, ctx.repo);
  return changed;
}

const EXPLORED_MS = 30_000;
const explored = new Map<string, { at: number; value: Promise<Json> }>();

/** The public listing of every cell: a public answer, so an isolate keeps it for 30 seconds
 * and a person on one cell pays for the ocean once. A cell's own part stays uncached. */
export function exploreCells(env: Env, url: URL, now = Date.now()) {
  const local = () => explore(env, url.searchParams);
  const others = allCells(env).filter((cell) => cell !== thisCell(env));
  const asked = currentScope()?.req;
  if (!cellsOn(env) || others.length === 0 || (asked && askedHere(asked))) return local();
  const kept = explored.get(url.search);
  if (kept && now - kept.at < EXPLORED_MS) return kept.value;
  const value = acrossCells(env, `${url.pathname}${url.search}`, local, mergeListed, others);
  if (explored.size > 100) explored.clear();
  explored.set(url.search, { at: now, value });
  return value;
}

/** `GET /explore?limit&before`: public repositories, newest first; `before` (a creation
 * time, exclusive) pages. Open to anyone. */
export async function explore(env: Env, query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get('limit') ?? 50) || 50, 1), EXPLORE_LIMIT);
  const before = Number(query.get('before') ?? '') || Number.MAX_SAFE_INTEGER;
  const listed = await env.INDEX.prepare(
    `SELECT id,name,workspace AS owner,created_at,visibility FROM platform_repos
       WHERE visibility='public' AND created_at<? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(before, limit)
    .all<{ id: string; name: string; owner: string; created_at: number; visibility: string }>();
  // A public listing never shows an owner's address: owners appear by handle.
  const repos = await withPaths(env, listed.results);
  return { repos: repos.map((r) => ({ ...r, owner: r.owner_handle })) };
}
