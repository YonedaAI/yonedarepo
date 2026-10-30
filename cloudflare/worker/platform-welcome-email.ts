// The account emails' consumer (platform side): the account_welcome and account_verify jobs
// (platform-email-verify.ts queues them), sent through Resend. A job names the account and,
// for a confirmation link, its token; the address is the contact email the account authority
// holds now. One welcome per account: the authority's sent marker, plus Resend's
// Idempotency-Key (24 hours) for a redelivery that races it. A confirmation email goes out
// only while its token is live and the address unconfirmed.
import { digest, verifyUrl } from './platform-email-verify';
import { renderVerify, renderWelcome } from './platform-welcome-template';
import type { Env, Envelope } from './types';
import { workspace } from './workspace';

export const RESEND_EMAILS = 'https://api.resend.com/emails';
/** Deliveries per message: the platform-jobs queue's max_retries (3) plus the first. */
const MAX_ATTEMPTS = 4;

let warnedOff = false;
/** Logs once per isolate why email is off (names only, never values). */
function off(reason: string) {
  if (warnedOff) return;
  warnedOff = true;
  console.warn(JSON.stringify({ event: 'email.off', reason }));
}

/** `a…@example.com`: enough to recognise a failure, never the whole address. */
export function maskAddress(address: string) {
  const at = address.lastIndexOf('@');
  return at > 0 ? `${address[0]}…${address.slice(at)}` : '…';
}

function config(env: Env) {
  const missing: string[] = (['EMAIL_FROM', 'EMAIL_CONTACT', 'WEB_ORIGIN'] as const).filter(
    (name) => !env[name]?.trim(),
  );
  if (!env.RESEND_API_KEY) missing.unshift('RESEND_API_KEY');
  if (missing.length) return off(`missing ${missing.join(', ')}`);
  return {
    from: env.EMAIL_FROM as string,
    contact: env.EMAIL_CONTACT as string,
    origin: (env.WEB_ORIGIN as string).replace(/\/+$/, ''),
  };
}

/** The Resend key from the Secrets Store, at send time; never logged. */
async function resendKey(env: Env) {
  try {
    const key = (await env.RESEND_API_KEY?.get())?.trim();
    if (key) return key;
  } catch {
    // The store's error is not logged: only that the key could not be read.
  }
  off('RESEND_API_KEY is empty or unreadable');
}

/** Seconds before delivery `attempts + 1`: 30 s, 2 min, 8 min. */
const backoff = (attempts: number) => 30 * 4 ** Math.max(0, attempts - 1);

/** Resend answers worth repeating: its own faults, rate limits and an in-flight duplicate. */
function transient(status: number, name: unknown) {
  return (
    status >= 500 || status === 429 || (status === 409 && name === 'concurrent_idempotent_requests')
  );
}

/**
 * The queue job (either kind): sends its email unless the account has no contact email, the
 * welcome was sent, or the confirmation is moot (address confirmed, token replaced or
 * expired). `{ retry }` asks the queue to redeliver after that many seconds; a permanent
 * failure is logged and settles the job.
 */
export async function welcomeJob(
  env: Env,
  envelope: Envelope,
  attempts: number,
  send: typeof fetch = fetch,
): Promise<{ retry?: number }> {
  const settings = config(env);
  const account = envelope.workspace;
  if (!settings || !account) return {};
  const confirm = envelope.kind === 'account_verify';
  const token = envelope.token;
  const state = await workspace(env, account, {
    op: 'email_status',
    ...(token ? { token_hash: await digest(token) } : {}),
  });
  const to = typeof state.email === 'string' ? state.email : null;
  const link =
    token && state.token_valid && !state.verified
      ? verifyUrl(settings.origin, account, token)
      : undefined;
  if (!to || (confirm && !link)) return {};
  if (!confirm && (await workspace(env, account, { op: 'welcome_state' })).sent) return {};
  const key = await resendKey(env);
  if (!key) return {};
  const email =
    link && confirm
      ? renderVerify({ ...settings, verifyUrl: link })
      : renderWelcome({ ...settings, verifyUrl: link });
  // Per account (welcome) or per token (confirmation); never the address or the token. The
  // welcome key carries the origin: dev and prod share one Resend account, where the same
  // username's key with another body is refused for 24 hours (invalid_idempotent_request).
  const idempotency = confirm
    ? `verify/${await digest(token ?? '')}`
    : `welcome/${await digest(`${settings.origin}\n${account}`)}`;
  const failed = (detail: Record<string, unknown>) => {
    if (attempts < MAX_ATTEMPTS && detail.transient) return { retry: backoff(attempts) };
    console.error(
      JSON.stringify({
        event: confirm ? 'email.verify.failed' : 'email.welcome.failed',
        to: maskAddress(to),
        attempts,
        ...detail,
      }),
    );
    return {};
  };
  let answer: Response;
  try {
    answer = await send(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': idempotency,
      },
      body: JSON.stringify({
        from: settings.from,
        to: [to],
        reply_to: settings.contact,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
  } catch (e: any) {
    return failed({ transient: true, error: String(e?.message ?? e).slice(0, 200) });
  }
  if (answer.ok) {
    if (!confirm) await workspace(env, account, { op: 'welcome_sent' });
    return {};
  }
  const body = await answer.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return failed({
    transient: transient(answer.status, body.name),
    status: answer.status,
    name: body.name,
  });
}
