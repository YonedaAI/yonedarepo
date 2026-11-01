// The undo window's schedule: repositories deleted and not yet purged. Each owner's authority
// holds its own (`deleted_repo:<id>`, accounts/deleted_repos.rs); D1's platform_deleted_repos is
// the rebuildable copy that lists them and that the every-minute sweep reads. The sweep sends an
// ordinary `platform_purge` for each that came due. Nothing waits in a queue or on an alarm:
// older code purges any tombstone a queue hands it, and SourceRepository has no alarm. Each
// row carries the due time it was promised, so a rollback of the switch keeps that promise: the
// sweep runs either way, and the authority refuses a purge that comes early (repo_store/undo.rs).
import { ApiError, type Json } from './repo-ops';
import { DAY_MS, undoMs } from './repo-undo-window';
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

/** Purges one sweep sends: a minute's work for the queue, not a burst. */
const SWEEP_LIMIT = 50;
/** When a sent purge's repository is still listed (a job lost, or a legal hold in its way) it
 * is sent again this much later. */
const SEND_AGAIN_MS = 6 * 60 * 60 * 1000;

const project = (env: Env, repo: string, owner: string, entry: Json) =>
  env.INDEX.prepare(
    `INSERT INTO platform_deleted_repos(id,workspace,name,visibility,created_at,deleted_at,purge_at)
       VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,name=excluded.name,
       visibility=excluded.visibility,created_at=excluded.created_at,
       deleted_at=excluded.deleted_at,purge_at=excluded.purge_at,sent_at=0`,
  ).bind(
    repo,
    owner,
    entry.name,
    entry.visibility,
    entry.created_at,
    entry.deleted_at,
    entry.purge_at,
  );

/** Puts a tombstone on the schedule, from what its authority answers (`repo_delete`, or
 * `repo_restore {check}`). One a purge has reached has no restoring left to offer. */
export async function parkDeleted(env: Env, repo: string, facts: Json) {
  if (facts.purge_started || typeof facts.purge_at !== 'number') return;
  const owner = String(facts.workspace);
  const { name, visibility, created_at, deleted_at, purge_at } = facts;
  const entry = { name, visibility, created_at, deleted_at, purge_at };
  await workspace(env, owner, { op: 'deleted_repo_put', repo, entry });
  await project(env, repo, owner, entry).run();
}

const listed = (env: Env, repo: string) =>
  env.INDEX.prepare('SELECT workspace FROM platform_deleted_repos WHERE id=?')
    .bind(repo)
    .first<{ workspace: string }>();

export const isDeletedListed = async (env: Env, repo: string) => Boolean(await listed(env, repo));

/** Takes `repo` off the schedule, restored or purged. `owner` may be empty: an erased
 * tombstone no longer knows, and the listing does. The owner's entry goes first, as the
 * listing's row is what brings a failed job back. */
export async function forgetDeleted(env: Env, repo: string, owner = '') {
  const account = owner || (await listed(env, repo))?.workspace;
  if (account) await workspace(env, account, { op: 'deleted_repo_remove', repo });
  await env.INDEX.prepare('DELETE FROM platform_deleted_repos WHERE id=?').bind(repo).run();
}

/** Sends the purges that came due, each once until SEND_AGAIN_MS has passed (the claim is one
 * statement, so overlapping runs send none twice). Answers how many. */
export async function sweepDeleted(env: Env, now = Date.now()) {
  const { results } = await env.INDEX.prepare(
    `UPDATE platform_deleted_repos SET sent_at=?1 WHERE id IN (
       SELECT id FROM platform_deleted_repos WHERE purge_at<=?1 AND sent_at<=?2
       ORDER BY purge_at LIMIT ?3) RETURNING id`,
  )
    .bind(now, now - SEND_AGAIN_MS, SWEEP_LIMIT)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  const job = (repo: string): Envelope => ({
    v: 1,
    kind: 'platform_purge',
    repo_id: repo,
    job_id: `due-${repo}`,
  });
  await env.PLATFORM_QUEUE.sendBatch(results.map(({ id }) => ({ body: job(id) })));
  return results.length;
}

/** `owner`'s repositories in their window, newest first, and the window's length in days. */
export async function deletedOf(env: Env, owner: string) {
  const { results } = await env.INDEX.prepare(
    `SELECT id,name,workspace AS owner,visibility,created_at,deleted_at,purge_at
       FROM platform_deleted_repos WHERE workspace=? ORDER BY deleted_at DESC LIMIT 200`,
  )
    .bind(owner)
    .all<{ id: string; owner: string }>();
  return { window_days: undoMs(env) / DAY_MS, repos: results };
}

/** Rebuilds D1's rows of `owner` from its authority. Answers how many it holds. */
export async function rebuildDeleted(env: Env, owner: string) {
  if (!owner) throw new ApiError('INVALID_INPUT', 'Name an owner');
  const { repos } = await workspace(env, owner, { op: 'deleted_repo_list' });
  const entries = repos as Json[];
  if (entries.length) await env.INDEX.batch(entries.map((e) => project(env, e.repo, owner, e)));
  return { repos: entries.length };
}
