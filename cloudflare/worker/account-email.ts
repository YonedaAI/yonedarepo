// The account-created hook (front and platform alike): a new account (password sign-up, or a
// first sign-in with GitHub or Google) asks the platform, through its entrypoint's
// `accountCreated` method, to queue the welcome email. The front reaches it over the PLATFORM
// service binding and the platform over SELF, so the front binds no platform queue. The
// platform sends it (platform-welcome-email.ts). Sign-up never waits on the platform or on
// Resend, and never fails because of email.
import { afterAnswer } from './background';
import type { Env } from './types';

/** The platform entrypoint's RPC surface this hook uses. */
type WelcomeTarget = { accountCreated(account: string): Promise<void> };

let warnedOff = false;

/**
 * Asks the platform to welcome `account`, after the response where the request lends its
 * waitUntil. `email` is the address the account stored (password sign-up's contact email, or
 * the provider's verified address); without one, no email. Never throws.
 */
export function accountCreated(env: Env, account: string, email: string | null) {
  return afterAnswer(async () => {
    if (!email) return;
    const platform = (env.PLATFORM ?? env.SELF) as unknown as Partial<WelcomeTarget> | undefined;
    if (typeof platform?.accountCreated !== 'function') {
      if (!warnedOff)
        console.warn(JSON.stringify({ event: 'email.off', reason: 'no platform binding' }));
      warnedOff = true;
      return;
    }
    try {
      await platform.accountCreated(account);
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 200);
      console.error(JSON.stringify({ event: 'email.welcome.enqueue_failed', error }));
    }
  });
}
