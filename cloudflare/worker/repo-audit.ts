// Repository events on their way to an organization's audit log (repo_store/audit_outbox.rs):
// each commits in the repository with its change, and this copies them to `audit:<owner>`
// after the answer, then settles them there. A slow or failed copy costs the action nothing:
// the events wait in the repository for its next change, and the log's cursor per source
// drops a repeat. A person has no log, so their repository's events are settled unread; a
// deleted org keeps the log it had. Off, no command asks for events, so none of this runs.
//
// A deleted repository is the case that can't wait for a next change. Its purge copies, and
// its erase job copies again before anything goes, and comes back until the log has them
// all: the authority refuses to erase before that, so a log that is down delays an erase and
// loses nothing. Off, an erase takes whatever is left with it.

import { auditOn } from './account-audit';
import { afterAnswer } from './background';
import { log } from './log';
import { sealWarned } from './platform-audit-seal';
import { ApiError, caller, type Json } from './repo-ops';
import type { Env } from './types';
import { auditLog, workspace } from './workspace';

const PAGE = 100;
/** Pages one copy moves; a longer backlog waits for the next. */
const ROUNDS = 5;
/** Pages a deletion's job moves: it has a whole invocation, and the rest is the next job's. */
const LEAVING_ROUNDS = 20;

const warned = (e: any) => log.warn('audit.repo_copy_failed', { error: e });

/** Whether `owner` keeps a log: an org answers for itself, or says it was deleted; a person
 * does neither. A deleted org's rows are the record of what happened to its repositories. */
const keepsLog = (env: Env, owner: string) =>
  workspace(env, owner, { op: 'org_access', account: owner }).then(
    () => true,
    async (e) => {
      if (e?.code !== 'NOT_FOUND') throw e;
      return (await workspace(env, owner, { op: 'org_retired' })).retired === true;
    },
  );

/** Moves up to `rounds` pages. Answers whether any is left, the owner, and whether it logged. */
async function copy(env: Env, repo: string, rounds = ROUNDS) {
  const call = caller(env, repo, { _system: 'audit' });
  let logged = false;
  for (let round = 0; ; round++) {
    const { events, workspace: owner } = await call({ op: 'repo_audit_pending', limit: PAGE });
    if (events.length === 0) return { left: false, owner, logged };
    logged = await keepsLog(env, owner);
    if (logged) {
      const source = `repo:${repo}`;
      await auditLog(env, owner, { op: 'audit_append', org: owner, source, events });
    }
    await call({ op: 'repo_audit_done', through: (events.at(-1) as Json).seq });
    if (events.length < PAGE) return { left: false, owner, logged };
    if (round + 1 === rounds) return { left: true, owner, logged };
  }
}

async function copyAndSeal(env: Env, repo: string) {
  const { owner, logged } = await copy(env, repo);
  if (logged) await sealWarned(env, owner);
}

/** After a change to `repo`: its events, after the answer. Never fails the change. */
export async function auditRepo(env: Env, repo: string) {
  if (auditOn(env)) await afterAnswer(() => copyAndSeal(env, repo).catch(warned));
}

/** `work`, then `auditRepo` once it has committed. */
export async function audited<T>(env: Env, repo: string, work: Promise<T>) {
  const answer = await work;
  await auditRepo(env, repo);
  return answer;
}

/** A deleted repository's events, all of them if it can, and the log sealed behind them.
 * Answers whether nothing is left, so its records may go. An erased tombstone, or one never
 * created, holds nothing. Never throws: what failed is simply still there. */
export async function auditRepoLeaving(env: Env, repo: string) {
  if (!auditOn(env)) return true;
  try {
    const { left, owner } = await copy(env, repo, LEAVING_ROUNDS);
    if (left) return false;
    if (await keepsLog(env, owner)) await sealWarned(env, owner, true);
    return true;
  } catch (e: any) {
    if (e instanceof ApiError && (e.code === 'GONE' || e.code === 'NOT_FOUND')) return true;
    warned(e);
    return false;
  }
}

/** A create taken back: nobody ever saw the repository, so its events go nowhere. If this
 * fails the purge copies them, which is true if untidy, so it never fails the take-back. */
export async function auditRepoForget(env: Env, repo: string) {
  if (!auditOn(env)) return;
  const call = caller(env, repo, { _system: 'audit' });
  await call({ op: 'repo_audit_done', through: Number.MAX_SAFE_INTEGER }).catch(warned);
}
