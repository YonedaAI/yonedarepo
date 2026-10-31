// Restoring a deleted repository, by whoever may delete it, until a purge reaches it
// (repo_store/undo.rs decides, and a purge that started wins). Modelled on a rename: the
// authority checks and answers who owns it, the owner's authority holds the name (it was freed
// at deletion, and NAME_TAKEN asks for another), a fork's parent takes it back, and only then
// does the repository commit. What follows repeats safely, so a retried restore finishes what
// an attempt left: the listing, its members, access everywhere, and every chain a deletion
// stopped. The schedule's entry goes last: while it is there, the owner can retry.
//
// Repository tokens stay revoked: whoever took the repository over may hold them. A managed
// agents connection has one, so its owner connects the repository again.

import { listRepository } from './repo-create';
import { forgetDeleted, isDeletedListed } from './repo-deleted';
import { forgetFork } from './repo-forks';
import { accessEverywhere } from './repo-head';
import { dispatchHooks } from './repo-hooks';
import { scheduleSweep } from './repo-lfs-sweep';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { requirePatScope } from './repo-pat';
import { handleOf, holdName, releaseNames } from './repo-paths';
import { dispatchObjects, dispatchProjection } from './repo-projection';
import { schedulePurge } from './repo-quarantine';
import { undoOn } from './repo-undo-window';
import type { Env } from './types';

const nameTaken = (name: string) =>
  new ApiError('NAME_TAKEN', `The name ${name} is taken now; restore it under a new name`);

/** A fork reads its parent's objects, so it needs a parent alive to take it back. */
async function reRegister(env: Env, parent: string, fork: string) {
  await caller(env, parent, { _system: 'fork' })({ op: 'repo_fork_register', fork }).catch((e) => {
    if (!['GONE', 'NOT_FOUND'].includes(e?.code)) throw e;
    throw new ApiError(
      'CONFLICT',
      'The repository this was forked from was deleted; restore that one first',
    );
  });
}

/** Back in the listing, as it was: its first date, not today's, and its members. A team's
 * row is keyed by name and id, as `git_member_put` writes it. */
async function relist(ctx: RepoContext, facts: Json, name: string) {
  const { env, repo } = ctx;
  const { workspace, visibility, created_at } = facts;
  await listRepository(env, repo, workspace, name, visibility, created_at);
  const { members } = await ctx.call({ op: 'repo_members' });
  const row = env.INDEX.prepare(
    'INSERT INTO platform_members(repo,account,role) VALUES(?,?,?) ON CONFLICT(repo,account) DO UPDATE SET role=excluded.role',
  );
  const rows = (members as Json[]).map((m) =>
    row.bind(repo, m.team_id ? `${m.account}#${m.team_id}` : m.account, m.role),
  );
  if (rows.length) await env.INDEX.batch(rows);
}

/** Everything a deletion stopped: its projections, hooks and the two sweeps' chains, which
 * end at a tombstone. Each finds nothing to do if nothing waits. */
async function rearm(env: Env, repo: string) {
  const now = Date.now();
  await Promise.all([
    dispatchProjection(env, repo),
    dispatchObjects(env, repo),
    dispatchHooks(env, repo),
    schedulePurge(env, repo, now),
    scheduleSweep(env, repo, now),
  ]);
}

/** `POST /repos/:id/restore {name?}`. */
export async function restoreRepository(env: Env, auth: Credentials, repo: string, name: unknown) {
  requirePatScope(auth, 'repo:admin');
  // With the switch off, only what was deleted while it was on.
  const scheduled = await isDeletedListed(env, repo);
  if (!scheduled && !undoOn(env)) throw new ApiError('NOT_FOUND', 'Nothing to restore');
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const facts = await ctx.call({ op: 'repo_restore', check: true, name });
  const owner = String(facts.workspace);
  const chosen = String(facts.name);
  const answer = async () => {
    const handle = await handleOf(env, owner);
    return { id: repo, name: chosen, restored: true, path: handle && `/${handle}/${chosen}` };
  };
  // Live, and nothing was left to finish.
  if (facts.already && !scheduled) return answer();
  const release = async () => {
    if (facts.already) return;
    await Promise.allSettled([
      releaseNames(env, owner, repo),
      ...(facts.parent ? [forgetFork(env, facts.parent, repo)] : []),
    ]);
  };
  await holdName(env, owner, repo, chosen).catch((e) => {
    throw e?.code === 'NAME_TAKEN' ? nameTaken(chosen) : e;
  });
  try {
    if (facts.parent) await reRegister(env, facts.parent, repo);
    await ctx.call({ op: 'repo_restore', name: chosen });
  } catch (e) {
    await release();
    throw e;
  }
  await relist(ctx, facts, chosen);
  await accessEverywhere(env, repo);
  await rearm(env, repo);
  await forgetDeleted(env, repo, owner);
  return answer();
}
