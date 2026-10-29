// The account emails' producer side (platform): a new account's welcome job, and the
// confirmation job a resend or an address change asks for. Each confirmation token is minted
// here, stored by the account authority only as its digest (single use, 24 hours), and rides
// in its queue message to the email; it is never logged. The platform entrypoint's
// `accountCreated` and `verifyEmail` methods (RPC, no HTTP route) call these.
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

/** Hex SHA-256 of `text`. */
export async function digest(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The confirmation page (a GET shows it; only its button's POST confirms). */
export function verifyUrl(origin: string, account: string, token: string) {
  return `${origin}/verify-email?account=${encodeURIComponent(account)}&token=${token}`;
}

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function enqueue(env: Env, job: Envelope) {
  if (!env.PLATFORM_QUEUE) throw new Error('PLATFORM_QUEUE is not bound');
  await env.PLATFORM_QUEUE.send(job);
}
const job = (kind: string, account: string, token?: string): Envelope => ({
  v: 1,
  kind,
  repo_id: '',
  job_id: kind === 'account_welcome' ? 'welcome' : 'verify',
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
