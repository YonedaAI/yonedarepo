// Account-level repository administration: listing an account's repositories and deleting
// one. Deletion makes the authority a tombstone in one transaction (GONE from then on, its
// repository tokens revoked), removes the D1 listing row, drops main's published head in
// every isolate before it answers (no read after the answer is served 200) and queues a platform job that purges the object store. Every step is idempotent, so a
// retried delete repeats whatever a failed attempt left undone.

import { teamEntries } from './platform-org-access';
import { unlistRepository } from './repo-create';
import { forgetFork } from './repo-forks';
import { dropDeletedHead } from './repo-head';
import { dispatchHooks } from './repo-hooks';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { releaseNames, withPaths } from './repo-paths';
import { dispatchPurge } from './repo-projection';
import { ownSpec } from './repo-stores';
import type { Env } from './types';

export { requirePatScope };

/** The workspace whose repositories `auth` may list or create in (never a repo token). */
export function accountOf(auth: Credentials): string {
  if ('_session' in auth) return auth._session.workspace;
  if ('_pat' in auth) return auth._pat.workspace;
  throw new ApiError('FORBIDDEN', 'Repository tokens are scoped to one repository');
}

type Listed = {
  id: string;
  name: string;
  created_at: number;
  owner: string;
  role: string;
  visibility: string;
};

const RANK = ['read', 'write', 'land', 'admin', 'owner'];

/** `GET /repos`: the account's own repositories, those of the orgs it owns, and those
 * shared with it or one of its teams, newest first, each with its owner and the account's
 * highest role (a token's allowlist and org limit narrow them). */
export async function listRepositories(env: Env, auth: Credentials) {
  const account = accountOf(auth);
  const orgs =
    '_session' in auth ? auth._session.orgs : '_pat' in auth ? auth._pat.orgs : undefined;
  const owned = Object.entries(orgs ?? {})
    .filter(([, a]) => a.role === 'owner')
    .map(([org]) => org);
  const entries = [account, ...teamEntries(orgs)];
  // Each list is one JSON parameter: D1 binds at most 100 per statement, and an account's
  // orgs and teams can outnumber that.
  const listed = await env.INDEX.prepare(
    `SELECT id,name,created_at,workspace AS owner,'owner' AS role,visibility FROM platform_repos
       WHERE workspace IN (SELECT value FROM json_each(?1))
     UNION ALL
     SELECT r.id,r.name,r.created_at,r.workspace AS owner,m.role,r.visibility FROM platform_members m
       JOIN platform_repos r ON r.id=m.repo WHERE m.account IN (SELECT value FROM json_each(?2))
     ORDER BY created_at DESC LIMIT 400`,
  )
    .bind(JSON.stringify([account, ...owned]), JSON.stringify(entries))
    .all<Listed>();
  // A repository reached several ways (directly and through teams) is listed once, by its
  // highest role.
  const best = new Map<string, Listed>();
  for (const r of listed.results) {
    const seen = best.get(r.id);
    if (!seen || RANK.indexOf(r.role) > RANK.indexOf(seen.role)) best.set(r.id, r);
  }
  const allowed = '_pat' in auth ? auth._pat.repos : null;
  const org = '_pat' in auth ? auth._pat.org : null;
  const repos = [...best.values()]
    .filter((r) => (!allowed || allowed.includes(r.id)) && (!org || r.owner === org))
    .slice(0, 200);
  return { repos: await withPaths(env, repos) };
}

/** `DELETE /repos/:id?confirm=<name>`: the owner (session or repo:admin token) only, never
 * an admin member. */
export async function deleteRepository(env: Env, auth: Credentials, repo: string, confirm: string) {
  requirePatScope(auth, 'repo:admin');
  if (!confirm) throw new ApiError('INVALID_INPUT', "confirm must be the repository's name");
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const listed = await env.INDEX.prepare('SELECT workspace FROM platform_repos WHERE id=?')
    .bind(repo)
    .first<{ workspace: string }>();
  const deleted = await ctx.call({ op: 'repo_delete', confirm });
  // Its names are free for the owner's next repositories.
  if (listed) await releaseNames(env, listed.workspace, repo);
  // A fork's parent stops counting it (the parent refuses deletion while forks remain).
  if (deleted.parent) await forgetFork(env, deleted.parent, repo);
  await unlistRepository(env, repo);
  await dropDeletedHead(env, repo);
  // Hooks subscribed to `repo` get repo.deleted, delivered from the tombstone (a repeated
  // delete names any still waiting, so a lost job is sent again).
  await Promise.all(
    ((deleted.hooks ?? []) as number[]).map((id) => dispatchHooks(env, repo, `hook:${id}`)),
  );
  await dispatchPurge(env, repo);
  return { deleted: true };
}

const R2_PAGE = 1000;

/** Deletes every R2 object under `prefix`, a page at a time. */
export async function purgePrefix(env: Env, prefix: string) {
  for (;;) {
    const page = await env.OBJECTS.list({ prefix, limit: R2_PAGE });
    if (page.objects.length > 0) await env.OBJECTS.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
}

/** The purge job: a deleted repository's object store and platform objects (check logs,
 * cached objects). Idempotent; the authority names the store only once it is a tombstone. */
export async function purgeRepository(env: Env, repo: string) {
  const target: Json = await caller(env, repo, { _system: 'purge' })({ op: 'repo_purge_target' });
  await purgePrefix(env, `platform/v1/${repo}/`);
  // A fork purges its own store, never the parent's it inherits from.
  const store = ownSpec(String(target.object_store ?? ''));
  const r2 = /^r2:([A-Za-z0-9._-]+)$/.exec(store);
  if (r2) await purgePrefix(env, `store/v1/${r2[1]}/`);
  // An Artifacts mirror a purge retired from it may be left to delete.
  for (const spec of [store, String(target.retired_mirror ?? '')]) {
    const artifacts = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
    if (artifacts && artifacts[1] === env.ARTIFACTS_NAMESPACE)
      await env.ARTIFACTS.delete(artifacts[2]).catch((e: any) => {
        // Already gone (an earlier attempt, or an import that never created it).
        if (!/not.?found/i.test(String(e?.message ?? e))) throw e;
      });
  }
}
