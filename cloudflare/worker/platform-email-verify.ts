// The account emails' producer side (platform): a new account's welcome job, the confirmation
// job a resend or an address change asks for, and a forgotten password's reset job. Each token
// is minted here, stored by the account authority only as its digest (single use, 24 hours for
// a confirmation, 1 hour for a reset), and rides in its queue message to the email; it is never
// logged. The platform entrypoint's `accountCreated`, `verifyEmail` and `passwordReset` methods
// (RPC, no HTTP route) call these.
import { carriedQueue } from './request-scope';
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

/** Hex SHA-256 of `text`. */
export async function digest(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The confirmation page (opening it confirms nothing; only its button's POST does) and the
 * reset page. The account and token ride in the fragment: unlike a query, it reaches no server,
 * so no request log, analytics line or Referer header can hold the token. */
export function verifyUrl(origin: string, account: string, token: string) {
  return `${origin}/verify-email#account=${encodeURIComponent(account)}&token=${token}`;
}
export function resetUrl(origin: string, account: string, token: string) {
  return `${origin}/reset-password#account=${encodeURIComponent(account)}&token=${token}`;
}

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function enqueue(env: Env, job: Envelope) {
  if (!env.PLATFORM_QUEUE) throw new Error('PLATFORM_QUEUE is not bound');
  await carriedQueue(env.PLATFORM_QUEUE).send(job);
}
const JOB_IDS: Record<string, string> = {
  account_welcome: 'welcome',
  account_verify: 'verify',
  account_password_reset: 'password_reset',
};
const job = (kind: string, account: string, token?: string): Envelope => ({
  v: 1,
  kind,
  repo_id: '',
  job_id: JOB_IDS[kind],
  workspace: account,
  ...(token ? { token } : {}),
});

/** A new account's welcome job, with a confirmation token while its address is unconfirmed
 * (a provider-verified address, or none, gets no token). */
export async function queueWelcome(env: Env, account: string) {
  const token = newToken();
  const issued = await workspace(env, account, {
    op: 'email_token',
    token_hash: await digest(token),
    purpose: 'welcome',
  }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null; // no such account: nothing to welcome
    throw e;
  });
  if (!issued) return;
  await enqueue(env, job('account_welcome', account, issued.issued ? token : undefined));
}

export type VerifyOutcome =
  | { sent: true }
  | { sent: false; reason: 'limited' | 'verified' | 'no_email' | 'same' };

/** Settings' resend (no `change`) or address change: a new token and its confirmation job,
 * unless the account authority refuses (limit, already confirmed, no or the same address).
 * An invalid address throws INVALID_INPUT. */
export async function verifyEmail(
  env: Env,
  account: string,
  change?: string,
): Promise<VerifyOutcome> {
  const token = newToken();
  const token_hash = await digest(token);
  const result =
    change === undefined
      ? await workspace(env, account, { op: 'email_token', token_hash, purpose: 'resend' })
      : await workspace(env, account, { op: 'email_change', email: change, token_hash });
  if (!(result.issued || result.changed)) return { sent: false, reason: result.reason };
  await enqueue(env, job('account_verify', account, token));
  return { sent: true };
}

/** Whether `key` has spent its limit. */
const limited = async (env: Env, key: string) =>
  env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key })).success;

/** A forgotten password: a reset link for a confirmed address, within the limits per account
 * and per email address (the authority's five a day holds the inbox; AUTH_LIMITER keeps a
 * flood off the authority). The asker has had the same answer whatever happens here, so a
 * refusal is silent. Limiter keys carry digests: an address never leaves this Worker. */
export async function passwordReset(env: Env, account: string) {
  const status = await workspace(env, account, { op: 'email_status' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null; // no such account
    throw e;
  });
  if (!status?.verified) return;
  if (await limited(env, `reset-account:${await digest(account)}`)) return;
  if (await limited(env, `reset-email:${await digest(status.email)}`)) return;
  const token = newToken();
  const result = await workspace(env, account, {
    op: 'password_reset_request',
    token_hash: await digest(token),
  });
  if (result.issued) await enqueue(env, job('account_password_reset', account, token));
}
