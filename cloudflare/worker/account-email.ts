// The welcome email: a new account (password sign-up, or a first sign-in with GitHub or
// Google) enqueues one platform job after the account exists, and the platform's queue
// consumer sends it through Resend. Sign-up never waits on Resend and never fails because of
// email. One email per account: the account authority's sent marker, plus Resend's
// Idempotency-Key (24 hours) for a redelivery that races the marker.

import { afterAnswer } from './background';
import { renderWelcome } from './email-welcome';
import { sha } from './storage';
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

/**
 * The account-created hook, for every path that creates an account: enqueues the welcome
 * email after the response where the request lends its waitUntil. `email` is the verified
 * address (OAuth); without it, an account named by an email address uses that, and a
 * username-only account gets no email. Never throws.
 */
export function accountCreated(env: Env, account: string, email?: string | null) {
  return afterAnswer(async () => {
    const to = email ?? (account.includes('@') ? account : null);
    if (!to) return;
    if (!env.PLATFORM_QUEUE) return off('PLATFORM_QUEUE is not bound');
    const job: Envelope = {
      v: 1,
      kind: 'account_welcome',
      repo_id: '',
      job_id: 'welcome',
      workspace: account,
      to,
    };
    try {
      await env.PLATFORM_QUEUE.send(job);
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 200);
      console.error(JSON.stringify({ event: 'email.welcome.enqueue_failed', error }));
    }
  });
}

function config(env: Env) {
  const missing = (['RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_CONTACT', 'WEB_ORIGIN'] as const).filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length) return off(`missing ${missing.join(', ')}`);
  return {
    key: env.RESEND_API_KEY as string,
    from: env.EMAIL_FROM as string,
    contact: env.EMAIL_CONTACT as string,
    origin: (env.WEB_ORIGIN as string).replace(/\/+$/, ''),
  };
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
 * The queue job: sends the welcome email unless it was sent. `{ retry }` asks the queue to
 * redeliver after that many seconds; a permanent failure is logged and settles the job.
 */
export async function welcomeJob(
  env: Env,
  envelope: Envelope,
  attempts: number,
  send: typeof fetch = fetch,
): Promise<{ retry?: number }> {
  const settings = config(env);
  const account = envelope.workspace;
  const to = envelope.to;
  if (!settings || !account || !to) return {};
  if ((await workspace(env, account, { op: 'welcome_state' })).sent) return {};
  const email = renderWelcome(settings);
  const failed = (detail: Record<string, unknown>) => {
    if (attempts < MAX_ATTEMPTS && detail.transient) return { retry: backoff(attempts) };
    console.error(
      JSON.stringify({ event: 'email.welcome.failed', to: maskAddress(to), attempts, ...detail }),
    );
    return {};
  };
  let answer: Response;
  try {
    answer = await send(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.key}`,
        'content-type': 'application/json',
        // Per account, never the address itself.
        'idempotency-key': `welcome/${await sha(account)}`,
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
    await workspace(env, account, { op: 'welcome_sent' });
    return {};
  }
  const body = await answer.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  return failed({
    transient: transient(answer.status, body.name),
    status: answer.status,
    name: body.name,
  });
}
