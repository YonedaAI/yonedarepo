// The welcome email, platform side: the account_welcome job (queued by the platform's
// `accountCreated` entrypoint method) and its consumer, which sends through Resend. The job
// names only the account; the address is the contact email the account authority holds.
// One email per account: the authority's sent marker, plus Resend's Idempotency-Key
// (24 hours) for a redelivery that races the marker.
import { renderWelcome } from './platform-welcome-template';
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

/** Queues the welcome job for a new account (its address is read when it runs). */
export async function queueWelcome(env: Env, account: string) {
  if (!env.PLATFORM_QUEUE) return off('PLATFORM_QUEUE is not bound');
  await env.PLATFORM_QUEUE.send({
    v: 1,
    kind: 'account_welcome',
    repo_id: '',
    job_id: 'welcome',
    workspace: account,
  });
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

/** The Idempotency-Key: per account, never the address or the account name itself. */
async function idempotencyKey(account: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account));
  return `welcome/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
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
 * The queue job: sends the welcome email unless it was sent or the account has no contact
 * email. `{ retry }` asks the queue to redeliver after that many seconds; a permanent
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
  const state = await workspace(env, account, { op: 'welcome_state' });
  const to = typeof state.email === 'string' ? state.email : null;
  if (state.sent || !to) return {};
  const key = await resendKey(env);
  if (!key) return {};
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
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': await idempotencyKey(account),
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
