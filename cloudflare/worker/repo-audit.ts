// Repository events on their way to an organization's audit log (repo_store/audit_outbox.rs):
// each commits in the repository with its change, and this copies them to `audit:<owner>`
// after the answer, then settles them there. A slow or failed copy costs the action nothing:
// the events wait in the repository for its next change, or for its purge, and the log's
// cursor per source drops a repeat. A person has no log, so their repository's events are
// settled unread. Off, no command asks for events, so none of this runs.

import { auditOn } from './account-audit';
import { afterAnswer } from './background';
import { log } from './log';
import { caller, type Json } from './repo-ops';
import type { Env } from './types';
import { auditLog, workspace } from './workspace';

const PAGE = 100;
/** Pages one copy moves; a longer backlog waits for the next. */
const ROUNDS = 5;

const warned = (e: any) => log.warn('audit.repo_copy_failed', { error: e });

/** Whether `owner` is an organization: it answers for itself, and a person doesn't. */
const isOrg = (env: Env, owner: string) =>
  workspace(env, owner, { op: 'org_access', account: owner }).then(
    () => true,
    (e) => {
      if (e?.code === 'NOT_FOUND') return false;
      throw e;
    },
  );

async function copy(env: Env, repo: string) {
  const call = caller(env, repo, { _system: 'audit' });
  for (let round = 0; round < ROUNDS; round++) {
    const { events, workspace: owner } = await call({ op: 'repo_audit_pending', limit: PAGE });
    if (events.length === 0) return;
    if (await isOrg(env, owner)) {
      const source = `repo:${repo}`;
      await auditLog(env, owner, { op: 'audit_append', org: owner, source, events });
    }
    await call({ op: 'repo_audit_done', through: (events.at(-1) as Json).seq });
    if (events.length < PAGE) return;
  }
}

/** After a change to `repo`: its events, after the answer. Never fails the change. */
export async function auditRepo(env: Env, repo: string) {
  if (auditOn(env)) await afterAnswer(() => copy(env, repo).catch(warned));
}

/** `work`, then `auditRepo` once it has committed. */
export async function audited<T>(env: Env, repo: string, work: Promise<T>) {
  const answer = await work;
  await auditRepo(env, repo);
  return answer;
}

/** What is still waiting, before an erase wipes it. */
export const auditRepoCatchUp = async (env: Env, repo: string) => {
  if (auditOn(env)) await copy(env, repo).catch(warned);
};
