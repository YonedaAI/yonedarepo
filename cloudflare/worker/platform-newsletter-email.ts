// The Flight log's confirmation email (platform side): the queue job a sign-up leaves
// (platform-newsletter.ts), sent through Resend. The job holds only the token; the address is the
// row that token still names. No such row means there's nothing to send: the address is already
// subscribed, is over its limit, or the link was replaced or used. Resend's Idempotency-Key
// covers a redelivery.
import { log } from './log';
import { digest } from './platform-email-verify';
import {
  confirmUrl,
  newsletterOn,
  PENDING_MS,
  unsubscribeToken,
  unsubscribeUrl,
} from './platform-newsletter';
import {
  backoff,
  config,
  MAX_ATTEMPTS,
  RESEND_EMAILS,
  resendKey,
  transient,
} from './platform-welcome-email';
import { renderNewsletterConfirm } from './platform-welcome-template';
import type { Env, Envelope } from './types';

/** `{ retry }` asks the queue to redeliver after that many seconds; a permanent failure is logged
 * and settles the job. */
export async function newsletterJob(
  env: Env,
  envelope: Envelope,
  attempts: number,
  send: typeof fetch = fetch,
): Promise<{ retry?: number }> {
  const settings = config(env);
  const { token } = envelope;
  if (!settings || !token || !newsletterOn(env)) return {};
  const tokenHash = await digest(token);
  const row = await env.INDEX.prepare(
    'SELECT id,email FROM newsletter_subscribers WHERE token_hash=? AND token_at>=?',
  )
    .bind(tokenHash, Date.now() - PENDING_MS)
    .first<{ id: number; email: string }>();
  if (!row) return {};
  const key = await resendKey(env);
  if (!key) return {};
  const signed = await unsubscribeToken(env, row.id);
  const email = renderNewsletterConfirm({
    ...settings,
    confirmUrl: confirmUrl(settings.origin, token),
    unsubscribeUrl: unsubscribeUrl(settings.origin, signed),
  });
  const failed = (detail: Record<string, unknown>) => {
    if (attempts < MAX_ATTEMPTS && detail.transient) return { retry: backoff(attempts) };
    log.error('email.newsletter.failed', { id: row.id, attempts, ...detail });
    return {};
  };
  let answer: Response;
  try {
    answer = await send(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `newsletter/${tokenHash}`,
      },
      body: JSON.stringify({
        from: settings.from,
        to: [row.email],
        reply_to: settings.contact,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: {
          'List-Unsubscribe': `<${settings.origin}/api/v1/newsletter/unsubscribe?token=${signed}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
  } catch (e: any) {
    return failed({ transient: true, error: String(e?.message ?? e).slice(0, 200) });
  }
  if (answer.ok) return {};
  const body = await answer.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return failed({
    transient: transient(answer.status, body.name),
    status: answer.status,
    name: body.name,
  });
}
