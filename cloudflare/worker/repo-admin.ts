// Account-level repository administration: listing an account's repositories and deleting
// one. Deletion makes the authority a tombstone in one transaction (GONE from then on, its
// repository tokens revoked), removes the D1 listing row, drops main's published head in
// every isolate before it answers (no read after the answer is served 200) and queues a platform job that purges the object store. Every step is idempotent, so a
// retried delete repeats whatever a failed attempt left undone.

import { teamEntries } from './platform-org-access';
import { forgetFork } from './repo-forks';
import { dropDeletedHead } from './repo-head';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { ownSpec } from './repo-stores';
import type { Env } from './types';

export { requirePatScope };

/** The workspace whose repositories `auth` may list or create in (never a repo token). */
export function accountOf(auth: Credentials): string {
  if ('_session' in auth) return auth._session.workspace;
  if ('_pat' in auth) return auth._pat.workspace;
  throw new ApiError('FORBIDDEN', 'Repository tokens are scoped to one repository');
}

type Listed = { id: string; name: string; created_at: number; owner: string; role: string };

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
  const marks = (list: string[], from: number) => list.map((_, i) => `?${from + i}`).join(',');
  const listed = await env.INDEX.prepare(
    `SELECT id,name,created_at,workspace AS owner,'owner' AS role FROM platform_repos
       WHERE workspace IN (${marks([account, ...owned], 1)})
     UNION ALL
     SELECT r.id,r.name,r.created_at,r.workspace AS owner,m.role FROM platform_members m
       JOIN platform_repos r ON r.id=m.repo WHERE m.account IN (${marks(entries, owned.length + 2)})
     ORDER BY created_at DESC LIMIT 400`,
  )
    .bind(account, ...owned, ...entries)
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
  return { repos };
}

/** `DELETE /repos/:id?confirm=<name>`: the owner (session or repo:admin token) only, never
 * an admin member. */
export async function deleteRepository(env: Env, auth: Credentials, repo: string, confirm: string) {
  requirePatScope(auth, 'repo:admin');
  if (!confirm) throw new ApiError('INVALID_INPUT', "confirm must be the repository's name");
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const deleted = await ctx.call({ op: 'repo_delete', confirm });
  // A fork's parent stops counting it (the parent refuses deletion while forks remain).
  if (deleted.parent) await forgetFork(env, deleted.parent, repo);
  await env.INDEX.batch([
    env.INDEX.prepare('DELETE FROM platform_repos WHERE id=?').bind(repo),
    env.INDEX.prepare('DELETE FROM platform_members WHERE repo=?').bind(repo),
  ]);
  await dropDeletedHead(env, repo);
  await env.PLATFORM_QUEUE.send({
    v: 1,
    repo_id: repo,
    job_id: `purge-${repo}`,
    kind: 'platform_purge',
  });
  return { deleted: true };
}

const R2_PAGE = 1000;

/** Deletes every R2 object under `prefix`, a page at a time. */
async function purgePrefix(env: Env, prefix: string) {
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
  const artifacts = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(store);
  if (artifacts && artifacts[1] === env.ARTIFACTS_NAMESPACE)
    await env.ARTIFACTS.delete(artifacts[2]).catch((e: any) => {
      // Already gone (an earlier attempt, or an import that never created it).
      if (!/not.?found/i.test(String(e?.message ?? e))) throw e;
    });
}
