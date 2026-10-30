// Account email, front and platform alike (the platform sends; platform-email-verify.ts).
// - The account-created hook: a new account (password sign-up, or a first sign-in with
//   GitHub or Google) tells the platform, through its entrypoint's `accountCreated` method,
//   which indexes it for the operators, queues their sign-up notice and, when the account
//   has an address, its welcome email. Sign-up never waits on it, and never fails for it.
// - `/api/auth/email*`: Settings shows the contact email, resends the confirmation or changes
//   the address (the entrypoint's `verifyEmail`), and the confirmation page POSTs its token.
// The front reaches the platform over the PLATFORM service binding and the platform itself
// over SELF, so the front binds no platform queue. Until confirmed, the address receives only
// the welcome and confirmation emails.
import { normalizeAccountIdentifier } from '../../shared/account';
import type { AccountCreated, SignupProvider } from './account-index';
import { afterAnswer } from './background';
import { error, readJson, response } from './http';
import { sha } from './storage';
import type { Env, Principal } from './types';
import { workspace } from './workspace';

type Outcome = { sent: true } | { sent: false; reason: string };
/** The platform entrypoint's RPC surface used here. */
type Platform = {
  accountCreated(account: string, details: AccountCreated): Promise<void>;
  verifyEmail(account: string, change?: string): Promise<Outcome>;
};
const platformOf = (env: Env) => (env.PLATFORM ?? env.SELF) as unknown as Platform | undefined;

let warnedOff = false;

/** A contact email (sign-up's required field, or a new address): normalized, or refused. */
export function contactEmail(value: unknown) {
  const email = typeof value === 'string' ? normalizeAccountIdentifier(value) : null;
  if (!email?.includes('@')) throw new Error('Enter a valid email address');
  return email;
}

/**
 * Tells the platform `account` is new, after the response where the request lends its
 * waitUntil. `email` is the address the account stored (password sign-up's contact email, or
 * the provider's verified address); without one, no welcome email. Never throws.
 */
export function accountCreated(
  env: Env,
  account: string,
  email: string | null,
  provider: SignupProvider,
) {
  return afterAnswer(async () => {
    const platform = platformOf(env);
    if (typeof platform?.accountCreated !== 'function') {
      if (!warnedOff)
        console.warn(JSON.stringify({ event: 'email.off', reason: 'no platform binding' }));
      warnedOff = true;
      return;
    }
    try {
      await platform.accountCreated(account, { provider, welcome: Boolean(email) });
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 200);
      console.error(JSON.stringify({ event: 'account.created.enqueue_failed', error }));
    }
  });
}

const LINK_INVALID =
  'This confirmation link is invalid, used or expired. Ask for a new one in Settings.';
const REFUSED: Record<string, [string, string, number]> = {
  limited: ['RATE_LIMITED', 'You asked for several emails today. Try again tomorrow.', 429],
  verified: ['ALREADY_VERIFIED', 'Your email address is already confirmed.', 409],
  no_email: ['NO_EMAIL', 'Add an email address first.', 409],
  same: ['SAME_EMAIL', 'That is already your email address.', 409],
};

/** `/api/auth/<action>` for `email`, `email/resend` and `email/verify`. */
export async function emailRoute(
  req: Request,
  env: Env,
  action: string,
  principal: () => Promise<Principal | null>,
): Promise<Response> {
  if (action === 'email/verify') {
    // Only the page's button: opening the link (a GET, or a mail scanner) confirms nothing.
    if (req.method !== 'POST') return error('NOT_FOUND', 'Unknown authentication route', 404);
    if (
      env.AUTH_LIMITER &&
      !(await env.AUTH_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'local' }))
        .success
    )
      return error('RATE_LIMITED', 'Wait before trying again', 429);
    const body = await readJson(req);
    const account =
      typeof body.account === 'string' ? normalizeAccountIdentifier(body.account) : null;
    const token =
      typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token) ? body.token : null;
    if (!account || !token) return error('INVALID_TOKEN', LINK_INVALID, 400);
    const result = await workspace(env, account, {
      op: 'email_verify',
      token_hash: await sha(token),
    }).catch(() => ({ verified: false })); // no such account
    return result.verified
      ? response({ verified: true })
      : error('INVALID_TOKEN', LINK_INVALID, 400);
  }
  const known =
    (action === 'email' && ['GET', 'POST'].includes(req.method)) ||
    (action === 'email/resend' && req.method === 'POST');
  if (!known) return error('NOT_FOUND', 'Unknown authentication route', 404);
  const who = await principal();
  if (!who) return error('UNAUTHORIZED', 'Sign in to manage your email address', 401);
  if (req.method === 'GET') {
    const status = await workspace(env, who.workspace, { op: 'email_status' });
    return response({ email: status.email ?? null, verified: Boolean(status.verified) });
  }
  const change = action === 'email' ? contactEmail((await readJson(req)).email) : undefined;
  const platform = platformOf(env);
  if (typeof platform?.verifyEmail !== 'function')
    return error('EMAIL_UNAVAILABLE', 'Email is not available right now', 503);
  const outcome = await platform.verifyEmail(who.workspace, change);
  if (outcome.sent) return response({ sent: true });
  const [code, message, status] = REFUSED[outcome.reason] ?? ['EMAIL_REFUSED', 'Not sent', 409];
  return error(code, message, status);
}
