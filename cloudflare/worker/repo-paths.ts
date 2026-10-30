// Readable repository paths: `/<handle>` is an account's or an org's profile and
// `/<handle>/<name>` one of its repositories. A handle is a person's or org's name, or the
// handle an email-named account picked (held on that name's own authority instance:
// accounts/handles.rs); an owner's authority holds its repositories' names, unique ignoring
// case, earlier names kept after a rename (accounts/repo_names.rs). Resolving a path asks two
// authorities by name, never a listing; repositories made before owners held names are found
// in the listing once (a rebuildable projection) and held from then on. A path a caller may
// not read answers exactly as one that names nothing.
import { normalizeHandle } from '../../shared/account';
import { profileAvatarUrl } from './avatars';
import { refreshHead } from './repo-head';
import { ApiError, type Credentials, caller, type Json, type RepoContext } from './repo-ops';
import { admitAnonymous } from './repo-public';
import type { Env } from './types';
import { workspace } from './workspace';

/** Whose a handle is: a person (`user`), an org, or an email-named account (`alias`), with
 * the account identifier its repositories are owned under. */
export type HandleOwner = { kind: 'user' | 'org' | 'alias'; account: string; handle: string };
type Named = { repo: string; name: string; renamed_from: string | null };

const missing = () => new ApiError('NOT_FOUND', 'No such repository');
const notFound = (e: any) => e?.code === 'NOT_FOUND';
/** An authority's refusal as the API's error. */
const api = (e: any): never => {
  throw typeof e?.code === 'string' ? new ApiError(e.code, e.message) : e;
};

/** Whose `handle` is (its own authority instance), or null: none, or not a handle. */
export async function ownerOf(env: Env, handle: string): Promise<HandleOwner | null> {
  const name = normalizeHandle(handle);
  if (!name) return null;
  return workspace(env, name, { op: 'handle_lookup' }).then(
    (owner) => owner as HandleOwner,
    (e) => (notFound(e) ? null : api(e)),
  );
}

/** The handle of `owner` (an account identifier): its name, or the handle an email-named
 * account picked (from the listing's projection), or null while it has none. */
export async function handleOf(env: Env, owner: string): Promise<string | null> {
  if (!owner.includes('@')) return owner;
  return (await handlesOf(env, [owner])).get(owner) ?? null;
}

/** The handles email-named `owners` picked (from the listing's projection), by owner. */
export async function handlesOf(env: Env, owners: string[]) {
  const emails = [...new Set(owners.filter((o) => o.includes('@')))];
  const handles = new Map<string, string>();
  if (emails.length === 0) return handles;
  const rows = await env.INDEX.prepare(
    'SELECT workspace,handle FROM platform_handles WHERE workspace IN (SELECT value FROM json_each(?))',
  )
    .bind(JSON.stringify(emails))
    .all<{ workspace: string; handle: string }>();
  for (const row of rows.results) handles.set(row.workspace, row.handle);
  return handles;
}

/** Listed repositories (`owner`: the account identifier) with their owner's handle and
 * readable path (null while an email-named owner has no handle). */
export async function withPaths<T extends { owner: string; name: string }>(env: Env, rows: T[]) {
  const handles = await handlesOf(
    env,
    rows.map((r) => r.owner),
  );
  return rows.map((row) => {
    const handle = row.owner.includes('@') ? (handles.get(row.owner) ?? null) : row.owner;
    return { ...row, owner_handle: handle, path: handle ? `/${handle}/${row.name}` : null };
  });
}

/** The repository `name` names among `owner`'s (any case; an earlier name too), or null. */
async function named(env: Env, owner: string, name: string): Promise<Named | null> {
  const held = await workspace(env, owner, { op: 'owned_repo_resolve', name }).then(
    (found) => found as Named,
    (e) => (notFound(e) ? null : api(e)),
  );
  if (held) return held;
  // Made before owners held names: the listing knows it, and its owner holds it from now.
  const listed = await listedNamed(env, owner, name);
  if (!listed) return null;
  await claim(env, owner, listed.id, listed.name).catch(() => {});
  return { repo: listed.id, name: listed.name, renamed_from: null };
}

const listedNamed = (env: Env, owner: string, name: string) =>
  env.INDEX.prepare(
    'SELECT id,name FROM platform_repos WHERE workspace=? AND name=? COLLATE NOCASE ORDER BY created_at LIMIT 1',
  )
    .bind(owner, name)
    .first<{ id: string; name: string }>();

const claim = (env: Env, owner: string, repo: string, name: string) =>
  workspace(env, owner, { op: 'owned_repo_claim', repo, name });

/**
 * Holds `name` among `owner`'s repositories for `repo` (a new one, or a rename):
 * NAME_TAKEN while another repository has it, also one made before owners held names. An
 * owner without an authority (a workspace an operator provisions) holds no names: its
 * repositories are reached by id. Answers the name it replaces (`renamed_from`).
 */
export async function holdName(env: Env, owner: string, repo: string, name: string) {
  const listed = await listedNamed(env, owner, name);
  if (listed && listed.id !== repo) {
    await claim(env, owner, listed.id, listed.name).catch(() => {});
    throw new ApiError('NAME_TAKEN', `This owner already has a repository named ${listed.name}`);
  }
  return claim(env, owner, repo, name).then(
    (held) => held,
    (e) => (notFound(e) ? { name, renamed_from: null } : api(e)),
  );
}

/** Frees `repo`'s names (a repository deleted, or one whose creation failed). */
export async function releaseNames(env: Env, owner: string, repo: string) {
  await workspace(env, owner, { op: 'owned_repo_release', repo }).catch((e) => {
    if (!notFound(e)) throw e;
  });
}

/** Whether `auth` may read `repo` (the same NOT_FOUND as for none when not). */
async function readable(env: Env, auth: Credentials | null, repo: string) {
  try {
    if (!auth) await admitAnonymous(env, repo);
    return await caller(env, repo, auth ?? { _anonymous: true })({ op: 'repo_status' });
  } catch (e: any) {
    if (['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'GONE'].includes(e?.code)) throw missing();
    throw e;
  }
}

/** The repository `/<handle>/<name>` names (no access decided), or null. */
export async function repoAt(env: Env, handle: string, name: string) {
  const owner = await ownerOf(env, handle);
  return owner ? ((await named(env, owner.account, name))?.repo ?? null) : null;
}

/** Whether `auth` (null: nobody signed in) may read `repo`. */
export const readableBy = (env: Env, auth: Credentials | null, repo: string) =>
  readable(env, auth, repo).then(
    () => true,
    (e) => (e?.code === 'NOT_FOUND' ? false : Promise.reject(e)),
  );

/** `GET /resolve/<handle>/<name>`: the repository a path names, for `auth` (null: nobody
 * signed in); an earlier name answers the current one (`renamed_from`). */
export async function resolvePath(
  env: Env,
  auth: Credentials | null,
  handle: string,
  name: string,
): Promise<Json> {
  const owner = await ownerOf(env, handle);
  const found = owner && (await named(env, owner.account, name.replace(/\.git$/, '')));
  if (!owner || !found) throw missing();
  await readable(env, auth, found.repo);
  return {
    id: found.repo,
    handle: owner.handle,
    name: found.name,
    path: `/${owner.handle}/${found.name}`,
    ...(found.renamed_from ? { renamed_from: found.renamed_from } : {}),
  };
}

/** `GET /repos/<id>/path`: a repository's readable path, for `auth`; NOT_FOUND alike for
 * one it may not read and one whose owner has no handle yet. */
export async function pathOf(env: Env, auth: Credentials | null, repo: string): Promise<Json> {
  const status = await readable(env, auth, repo);
  const row = await env.INDEX.prepare('SELECT workspace FROM platform_repos WHERE id=?')
    .bind(repo)
    .first<{ workspace: string }>();
  const handle = row && (await handleOf(env, row.workspace));
  if (!handle) throw missing();
  return { id: repo, handle, name: status.name, path: `/${handle}/${status.name}` };
}

/** `GET /profiles/<handle>`: whose the handle is and their public repositories. */
export async function profile(env: Env, handle: string): Promise<Json> {
  const owner = await ownerOf(env, handle);
  if (!owner) throw new ApiError('NOT_FOUND', 'Nobody has that handle');
  const listed = await env.INDEX.prepare(
    `SELECT id,name,created_at FROM platform_repos WHERE workspace=? AND visibility='public'
       ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(owner.account)
    .all<{ id: string; name: string; created_at: number }>();
  return {
    handle: owner.handle,
    kind: owner.kind === 'org' ? 'org' : 'user',
    display_name: null,
    // By handle, never by the account identifier (an address for an email-named account).
    avatar_url: await profileAvatarUrl(env, owner),
    repositories: listed.results.map((r) => ({ ...r, path: `/${owner.handle}/${r.name}` })),
  };
}

/** `PUT /repos/<id>/name {name}`: the owner renames a repository. The owner's authority
 * holds the new name first (NAME_TAKEN while another of theirs has it), keeping the old one
 * as an earlier name that still resolves; then the repository takes it. */
export async function renameRepository(ctx: RepoContext, name: unknown): Promise<Json> {
  const checked = await ctx.call({ op: 'repo_rename', name, check: true });
  const owner = String(checked.workspace);
  await holdName(ctx.env, owner, ctx.repo, checked.name);
  try {
    await ctx.call({ op: 'repo_rename', name: checked.name });
  } catch (e) {
    await holdName(ctx.env, owner, ctx.repo, checked.previous).catch(() => {});
    throw e;
  }
  await ctx.env.INDEX.prepare('UPDATE platform_repos SET name=? WHERE id=?')
    .bind(checked.name, ctx.repo)
    .run();
  await refreshHead(ctx.env, ctx.repo);
  const handle = await handleOf(ctx.env, owner);
  return {
    name: checked.name,
    previous: checked.previous,
    path: handle ? `/${handle}/${checked.name}` : null,
  };
}

/** A repository's status with its owner's handle and readable path (from the listing). */
export async function withPath(env: Env, repo: string, status: Json): Promise<Json> {
  const row = await env.INDEX.prepare('SELECT workspace FROM platform_repos WHERE id=?')
    .bind(repo)
    .first<{ workspace: string }>();
  const handle = row ? await handleOf(env, row.workspace) : null;
  return { ...status, owner_handle: handle, path: handle ? `/${handle}/${status.name}` : null };
}
