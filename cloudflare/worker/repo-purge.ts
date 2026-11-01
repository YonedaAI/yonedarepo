// An owner purging a deleted repository now, instead of waiting out the undo window: the same
// job as an operator's purge-now. It takes the owner signed in, never a token: a token can
// delete, and the window is what survives a stolen one. The authority decides who and puts the
// mark in one transaction (`repo_purge_now`, repo_store/undo.rs), so a legal hold refuses it, and
// from that commit no restore can win, whatever the queue does. What follows repeats safely:
// asking again finishes an attempt that died, and a job lost after this point is sent again by
// the sweep (repo-deleted.ts).

import { auditBegin, auditEnd } from './platform-admin-queries';
import { accountOf } from './repo-admin';
import { audited } from './repo-audit';
import { isDeletedListed, leaveDeletedList } from './repo-deleted';
import { ApiError, type Credentials, caller, type Json } from './repo-ops';
import { dispatchPurge } from './repo-projection';
import { undoOn } from './repo-undo-window';
import type { Env } from './types';

/** Queues the purge with its row in the operators' log, which a job's end settles. */
async function sendPurge(env: Env, actor: string, repo: string, detail: Json) {
  const row = await auditBegin(env, actor, 'repo.purge_owner', repo, detail);
  try {
    await dispatchPurge(env, repo, 'now');
  } catch (e: any) {
    await auditEnd(env, row, { ...detail, failed: e?.code ?? 'INTERNAL' });
    throw e;
  }
  await auditEnd(env, row, { ...detail, queued: true });
}

/** `POST /repos/:id/purge`. A repository a purge finished answers as if asked the first time. A
 * token is told before anything is read, whatever its scopes, as no scope would help and the
 * answer says nothing of the repository. */
export async function purgeDeleted(env: Env, auth: Credentials, repo: string) {
  if ('_pat' in auth || '_token' in auth)
    throw new ApiError(
      'FORBIDDEN',
      "Only the owner, signed in, can delete a repository for good. A token can't",
    );
  // With the switch off, only what was deleted while it was on.
  if (!undoOn(env) && !(await isDeletedListed(env, repo)))
    throw new ApiError('NOT_FOUND', 'Nothing to delete');
  const facts = await audited(env, repo, caller(env, repo, auth)({ op: 'repo_purge_now' }));
  if (!facts.finished) {
    const detail = { name: facts.name, owner: facts.workspace };
    await sendPurge(env, accountOf(auth), repo, detail);
    await leaveDeletedList(env, repo);
  }
  return { purged: true };
}
