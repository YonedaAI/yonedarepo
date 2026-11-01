// What a restore checks before it commits: that the repository's objects are still there. The
// purge mark (repo_store/undo.rs) can't say so for every tombstone: a build older than the mark
// purged without it, and a rollback's job can purge a listed one. So two things must hold, and
// each covers what the other can't. The repository must be on its owner's schedule, which only
// a deletion with the window on writes, so nothing an older build deleted comes back, even half
// purged. And its head must still be in a tier a purge empties. The Cache API is never asked: it
// outlives a purge, and would answer for bytes nothing else holds. Nothing here writes, so a
// refusal leaves the tombstone as it was, and a look that fails restores nothing.

import { log } from './log';
import { bundleKey } from './repo-bundles';
import { parseStore, RepoObjects } from './repo-objects';
import { ApiError, type Json } from './repo-ops';
import { stagedInShardOf } from './repo-shards';
import type { Env } from './types';
import { workspace } from './workspace';

type Head = { commit: string; bundle: string | null; staged: boolean };

/** D1's row is a projection; the owner's record is what it was built from. */
async function onSchedule(env: Env, owner: string, repo: string) {
  const { repos } = await workspace(env, owner, { op: 'deleted_repo_list' });
  return (repos as Json[]).some((entry) => entry.repo === repo);
}

const goneIsNothing = (e: any) => {
  if (e?.code === 'GONE' || e?.code === 'NOT_FOUND') return null;
  throw e;
};

/** Whether `head` is in the authority, R2, a commit shard, the object store or a fork's parent. */
async function held(env: Env, repo: string, spec: string, head: Head) {
  if (head.staged) return true;
  const objects = new RepoObjects(env, repo, parseStore(env, spec));
  const { commit, bundle } = head;
  const keys = [objects.rawKey(commit), objects.key(commit)];
  if (bundle) keys.push(bundleKey(repo, bundle));
  if ((await Promise.all(keys.map((key) => env.OBJECTS.head(key)))).some(Boolean)) return true;
  if ((await stagedInShardOf(env, repo, commit, [commit])).length > 0) return true;
  if (await objects.store.readCommit(commit).catch(goneIsNothing)) return true;
  return Boolean(await objects.inherited?.bytes(commit, 'commit', false).catch(goneIsNothing));
}

/** Refuses a restore of a tombstone (`facts`, its `repo_restore {check}`) that has lost its
 * objects, or that nothing can say has kept them. `scheduled`: D1 already lists it. */
export async function requireHeld(env: Env, repo: string, facts: Json, scheduled: boolean) {
  const look = async () => {
    if (!scheduled && !(await onSchedule(env, String(facts.workspace), repo)))
      throw new ApiError('GONE', 'This repository was deleted too long ago to restore');
    if (facts.head && !(await held(env, repo, String(facts.object_store), facts.head)))
      throw new ApiError('GONE', "This repository's files were deleted, so it can't be restored");
  };
  await look().catch((e) => {
    if (e instanceof ApiError) throw e;
    log.warn('repo.restore_look_failed', { repo, error: e });
    throw new ApiError('OVERLOADED', "Couldn't check this repository's files. Try again");
  });
}
