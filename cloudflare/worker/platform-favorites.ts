// Favorite repositories (`/api/v1/favorites[/<repo>]`): the repositories a signed-in person
// keeps at the top of the picker. The account authority holds the ids; every read and every
// add checks them against the listing, so a favorite shows nothing the account cannot read:
// a private repository is refused exactly as a missing one, and a favorite that went out of
// reach (deleted, private again, access removed) drops from the list, and returns with access.
import { reachOf } from './repo-admin';
import { ApiError, type Credentials, type Json } from './repo-ops';
import { withPaths } from './repo-paths';
import type { Env } from './types';
import { workspace } from './workspace';

type Saved = { repo: string; added_at: number };
type Readable = { id: string; name: string; owner: string; visibility: string };

/** The signed-in person; a token or a script keeps no favorites. */
function person(auth: Credentials): string {
  if ('_session' in auth && auth._session.human) return auth._session.workspace;
  throw new ApiError('UNAUTHORIZED', 'Sign in to your account to keep favorites');
}

/** Of `ids`, those the caller may read: public ones and those `GET /repos` lists for it. */
async function readable(env: Env, auth: Credentials, ids: string[]) {
  const { owners, entries } = reachOf(auth);
  const listed = await env.INDEX.prepare(
    `SELECT r.id,r.name,r.workspace AS owner,r.visibility FROM platform_repos r
       WHERE r.id IN (SELECT value FROM json_each(?1)) AND (
         r.visibility='public'
         OR r.workspace IN (SELECT value FROM json_each(?2))
         OR EXISTS (SELECT 1 FROM platform_members m WHERE m.repo=r.id
           AND m.account IN (SELECT value FROM json_each(?3))))`,
  )
    .bind(JSON.stringify(ids), JSON.stringify(owners), JSON.stringify(entries))
    .all<Readable>();
  return listed.results;
}

const saved = async (env: Env, account: string) =>
  (await workspace(env, account, { op: 'favorite_list' })).favorites as Saved[];

async function list(env: Env, auth: Credentials, account: string) {
  const favorites = await saved(env, account);
  const found = await readable(
    env,
    auth,
    favorites.map((f) => f.repo),
  );
  const named = new Map((await withPaths(env, found)).map((r) => [r.id, r]));
  // By handle only: the owner of a public repository may be a stranger's address.
  return favorites.flatMap(({ repo, added_at }) => {
    const row = named.get(repo);
    return row
      ? [
          {
            id: row.id,
            name: row.name,
            owner_handle: row.owner_handle,
            path: row.path,
            visibility: row.visibility,
            added_at,
          },
        ]
      : [];
  });
}

async function add(env: Env, auth: Credentials, account: string, repo: string) {
  if (!(await readable(env, auth, [repo])).length)
    throw new ApiError('NOT_FOUND', 'Repository not found');
  const put = () => workspace(env, account, { op: 'favorite_put', repo });
  try {
    return await put();
  } catch (e: any) {
    if (e?.code !== 'FAVORITES_FULL') throw e;
    // Favorites out of reach hold places the list no longer shows: those go first.
    const ids = (await saved(env, account)).map((f) => f.repo);
    const kept = new Set((await readable(env, auth, ids)).map((r) => r.id));
    const repos = ids.filter((id) => !kept.has(id));
    if (!repos.length) throw e;
    await workspace(env, account, { op: 'favorite_remove', repos });
    return put();
  }
}

/** `GET /favorites`, `PUT` and `DELETE /favorites/<repo>` for a signed-in person. */
export async function favoritesRoute(
  env: Env,
  auth: Credentials,
  method: string,
  repo: string | undefined,
): Promise<Json> {
  const account = person(auth);
  if (!repo && method === 'GET') return { favorites: await list(env, auth, account) };
  if (repo && /^r[0-9a-f]{20}$/.test(repo)) {
    if (method === 'PUT') return add(env, auth, account, repo);
    if (method === 'DELETE')
      return workspace(env, account, { op: 'favorite_remove', repos: [repo] });
  }
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
