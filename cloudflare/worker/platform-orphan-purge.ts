// Purging an orphan: a live repository whose org was deleted. Nobody can act for that owner, so
// it can never be deleted the usual way, and purge-now refuses what is not deleted. An operator
// names it, and this deletes it as its owner would, so its listing, names, fork parent and hooks
// are settled as for any deletion, then purges it at once. Only a retired org counts: that is
// final, while an owner with no record is a workspace an operator provisioned, not one known to
// be gone. A hold stops this whether or not the `LEGAL_HOLD` switch is on: nothing here can be
// undone. Every step repeats safely, so a failed attempt is finished by asking again.
import { auditBegin, auditEnd } from './platform-admin-queries';
import { verifiedHold } from './platform-legal-hold';
import { deleteRepository } from './repo-admin';
import { ApiError, caller, type Json } from './repo-ops';
import { dispatchPurge } from './repo-projection';
import { undoOn } from './repo-undo-window';
import type { Env } from './types';
import { workspace } from './workspace';

async function refuseHeld(env: Env, owner: string, repo: string) {
  const hold = await verifiedHold(env, owner, repo).catch((e) => {
    throw new ApiError('LEGAL_HOLD', e.message);
  });
  if (hold !== 'off' && hold.held)
    throw new ApiError('LEGAL_HOLD', 'This repository is under a legal hold: nothing is purged');
}

/** `POST /admin/repos/:id/purge-orphan {confirm}`, `confirm` being the repository's name. The
 * owner comes from its authority, as the listing is only a projection. */
export async function purgeOrphan(env: Env, actor: string, repo: string, body: Json) {
  const confirm = typeof body.confirm === 'string' ? body.confirm : '';
  if (!confirm) throw new ApiError('INVALID_INPUT', "confirm must be the repository's name");
  const found = await caller(env, repo, { _system: 'purge' })({ op: 'repo_hold_owner' });
  const owner = String(found.owner);
  const { retired } = await workspace(env, owner, { op: 'org_retired' });
  if (retired !== true) throw new ApiError('CONFLICT', 'That repository still has an owner');
  await refuseHeld(env, owner, repo);
  const row = await auditBegin(env, actor, 'repo.purge_orphan', repo, { owner });
  const auth = { _session: { workspace: owner, principal: 'admin' } };
  try {
    await deleteRepository(env, auth, repo, confirm);
    // Without a window the deletion queued its purge; with one, this skips it.
    if (undoOn(env)) await dispatchPurge(env, repo, 'now');
  } catch (e: any) {
    await auditEnd(env, row, { owner, failed: e?.code ?? 'INTERNAL' });
    throw e;
  }
  await auditEnd(env, row, { owner, queued: true });
  return { queued: true };
}
