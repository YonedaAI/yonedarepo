// The reset link's email (platform side): the job platform-email-verify.ts queues, sent through
// Resend to the confirmed address the account authority holds now, and only while the token is
// live. The token rides in the queue message and the link; it is never logged.
import { log } from './log';
import { digest, resetUrl } from './platform-email-verify';
import { backoff, config, MAX_ATTEMPTS, postEmail, resendKey } from './platform-welcome-email';
import { renderPasswordReset } from './platform-welcome-template';
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

/** `{ retry }` asks the queue to redeliver after that many seconds; a permanent failure is
 * logged and settles the job. */
export async function passwordResetJob(
  env: Env,
  envelope: Envelope,
  attempts: number,
  send: typeof fetch = fetch,
): Promise<{ retry?: number }> {
  const settings = config(env);
  const { workspace: account, token } = envelope;
  if (!settings || !account || !token) return {};
  const token_hash = await digest(token);
  const { email: to } = await workspace(env, account, { op: 'password_reset_status', token_hash });
  if (typeof to !== 'string') return {};
  const key = await resendKey(env);
  if (!key) return {};
  const link = resetUrl(settings.origin, account, token);
  const email = renderPasswordReset({ ...settings, resetUrl: link });
  // Per token, never the token or the address: dev and prod share one Resend account.
  const failure = await postEmail(send, key, settings, to, email, `reset/${token_hash}`);
  if (!failure) return {};
  if (attempts < MAX_ATTEMPTS && failure.transient) return { retry: backoff(attempts) };
  log.error('email.reset.failed', { account, attempts, ...failure });
  return {};
}
