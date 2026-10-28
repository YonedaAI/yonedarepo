// Public repositories, the adapter half (the rules are the authority's: repo_store/
// visibility.rs). A request without credentials is anonymous (`{_anonymous: true}`) where
// it may read: GETs of one repository's API, smart-HTTP fetches and LFS downloads, and the
// public listing. The authority admits it on a public repository and answers NOT_FOUND on
// a private one. Anonymous requests are rate limited per client address, and the costly
// reads (search, blame) more tightly and with smaller results. Visibility changes update the
// discovery listing on the side that never lists a private repository, and republish main's
// head before answering, so a repository made private stops serving anonymous reads
// everywhere within ACCESS_MS.
import { refreshHead } from './repo-head';
import { ApiError, type Credentials, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

export const ANONYMOUS: Credentials = { _anonymous: true };

const REPO_READ = /^\/api\/v1\/repos\/r[0-9a-f]{20}(?:\/|$)/;
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
  const changed = await ctx.call({ op: 'repo_set_visibility', visibility });
  await refreshHead(ctx.env, ctx.repo, true);
  if (visibility === 'public') await listVisibility(ctx.env, ctx.repo, visibility);
  return changed;
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
    .all();
  return { repos: listed.results };
}
