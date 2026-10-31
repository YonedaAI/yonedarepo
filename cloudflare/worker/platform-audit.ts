// Organization audit logs (`audit:<org>`, audit_log.rs), behind AUDIT_LOG. Events commit in
// their own authorities with the state they record: the org's, and each member's for their
// org-limited tokens and SSH keys. They reach the log by a copy after the answer, so a slow
// or failed log costs the action nothing; the source keeps its events and the log a cursor
// per source, so the next copy (or, for the org's own events, the next read) catches up.
// This module stays free of the repository adapters: the front Worker loads it for sign-ins.
import { afterAnswer } from './background';
import type { Env, Json } from './types';
import { auditLog, workspace } from './workspace';

const PAGE = 100;
/** Pages one copy moves; a longer backlog waits for the next. */
const ROUNDS = 5;

export const auditOn = (env: Env) => env.AUDIT_LOG === 'on';

const warned = (e: any) => console.warn(`audit copy failed: ${e?.message ?? e}`);

/** Copies what `account`'s authority holds for `org` past the log's cursor for it. */
async function copy(env: Env, org: string, account: string) {
  const source = `account:${account}`;
  let { cursor: after } = await auditLog(env, org, { op: 'audit_cursor', source });
  for (let round = 0; round < ROUNDS; round++) {
    const { events } = await workspace(env, account, {
      op: 'audit_pending',
      org,
      after,
      limit: PAGE,
    });
    if (events.length === 0) return;
    ({ cursor: after } = await auditLog(env, org, { op: 'audit_append', org, source, events }));
    if (events.length < PAGE) return;
  }
}

/** After a change to `org`: its own events, after the answer. Never fails the change. */
export async function auditOrg(env: Env, org: string) {
  if (auditOn(env)) await afterAnswer(() => copy(env, org, org).catch(warned));
}

/** After `account` changed a credential: what its orgs should see, after the answer. */
export async function auditMember(env: Env, account: string) {
  if (!auditOn(env)) return;
  await afterAnswer(async () => {
    const { orgs } = await workspace(env, account, { op: 'audit_targets' });
    await Promise.all((orgs as string[]).map((org) => copy(env, org, account).catch(warned)));
  }).catch(warned);
}

/** A device approved or denied, on the person's own log (the code's instance is short-lived). */
export async function auditDevice(env: Env, account: string, answer: Json) {
  if (!auditOn(env)) return;
  const noted = {
    op: 'device_noted',
    approved: answer.approved === true,
    client: answer.client_name,
    host: answer.host ?? null,
  };
  await afterAnswer(() => workspace(env, account, noted).catch(warned));
}

/** Brings the org's own events up to date for a reader; failing that, it reads what's there. */
export const auditCatchUp = (env: Env, org: string) => copy(env, org, org).catch(warned);
