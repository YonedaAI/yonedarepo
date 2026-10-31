// Legal hold's adapter half (repo_store/legal_hold.rs and accounts/holds.rs decide). Behind
// `LEGAL_HOLD`: while it is not `on`, every command says `_hold: "off"`, the authority checks
// nothing and the hold routes answer NOT_FOUND. While it is, a destructive op comes back
// `HOLD_UNCHECKED` naming the repository's owner, and `caller` asks that owner's authority
// and sends the op again with the answer, so only destructive paths pay. A hold set while a
// destructive job runs reaches it at its next listed op, not sooner: the two authorities
// share no transaction.
import type { Env, Envelope, Json } from './types';
import { workspace } from './workspace';

type Switch = { LEGAL_HOLD?: string };
/** The answer the authority takes: the owner's, or that the switch is off. */
export type HoldAnswer = 'off' | { held: boolean };

/** The longest delay a queue message takes: a held job looks again this often. */
const LATER_SECONDS = 12 * 60 * 60;

export const holdsOn = (env: Switch) => env.LEGAL_HOLD === 'on';

/** What every command carries while the switch is off (never from client input). */
export const holdSwitch = (env: Switch) => (holdsOn(env) ? {} : { _hold: 'off' as const });

const refusal = (message: string) => Object.assign(new Error(message), { code: 'LEGAL_HOLD' });

/** The owner's answer for `repo`. One that cannot be read refuses the op that needs it, as
 * a hold would: nothing is destroyed on a guess. */
export async function verifiedHold(env: Env, owner: string, repo: string): Promise<HoldAnswer> {
  const unread = 'The legal hold could not be read, so nothing was deleted. Try again.';
  const answer = await workspace(env, owner, { op: 'hold_check', repo }).catch(() => {
    throw refusal(unread);
  });
  if (typeof answer.held !== 'boolean') throw refusal(unread);
  return { held: answer.held };
}

/** The answer for work outside the authority, asked fresh: a commit shard has no owner to
 * name, so `call` (a caller that may read a tombstone) finds it. */
export async function currentHold(
  env: Env,
  repo: string,
  call: (command: Json) => Promise<Json>,
): Promise<HoldAnswer> {
  if (!holdsOn(env)) return 'off';
  const { owner } = await call({ op: 'repo_hold_owner' });
  return verifiedHold(env, String(owner), repo);
}

/** Runs a queue job that a hold may refuse: a held job goes back on the queue for later, as
 * a new message, so a hold that lasts years never spends the job's retries on the way to
 * the dead-letter queue. */
export async function laterIfHeld(env: Env, envelope: Envelope, job: () => Promise<unknown>) {
  try {
    await job();
  } catch (e: any) {
    if (e?.code !== 'LEGAL_HOLD') throw e;
    await env.PLATFORM_QUEUE.send(envelope, { delaySeconds: LATER_SECONDS });
  }
}
