// The operators' sign-up notice (platform side): the admin_signup_notice job a new account
// queues (platform-accounts.ts) emails ADMIN_NOTIFY_EMAIL (else EMAIL_CONTACT) through
// Resend. At most one email per five minutes: a sign-up inside that window is sent again
// after it, and the next email names every sign-up since the last ("+N more"). A job whose
// sign-up an earlier email covered sends nothing; a redelivery that races the record of a
// sent email repeats Resend's Idempotency-Key (24 hours; the sign-ups it names), so no notice
// goes out twice.
import { digest } from './platform-email-verify';
import {
  backoff,
  MAX_ATTEMPTS,
  RESEND_EMAILS,
  resendKey,
  transient,
} from './platform-welcome-email';
import { escapeHtml } from './platform-welcome-template';
import type { Env, Envelope } from './types';

export const NOTICE_WINDOW_MS = 5 * 60_000;
/** Sign-ups one email names by line; the rest are a count. */
const LISTED = 20;
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  email: 'email',
};

type SignUp = { account: string; created_at: number; provider: string; handle: string | null };

function config(env: Env) {
  const to = env.ADMIN_NOTIFY_EMAIL?.trim() || env.EMAIL_CONTACT?.trim();
  const from = env.EMAIL_FROM?.trim();
  const origin = env.WEB_ORIGIN?.trim().replace(/\/+$/, '');
  return to && from && origin && env.RESEND_API_KEY ? { to, from, origin } : null;
}

/**
 * The job: sends the notice now, later (inside the window), or not at all (covered already,
 * or email unconfigured). `{ retry }` asks the queue to redeliver after that many seconds.
 */
export async function signupNoticeJob(
  env: Env,
  envelope: Envelope,
  attempts = 1,
  send: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ retry?: number }> {
  const settings = config(env);
  const account = envelope.workspace;
  if (!settings || !account) return {};
  const row = await env.INDEX.prepare('SELECT created_at FROM platform_accounts WHERE account=?')
    .bind(account)
    .first<{ created_at: number }>();
  if (!row) return {};
  const state = await env.INDEX.prepare(
    "SELECT sent_at,through FROM admin_notices WHERE kind='signup'",
  ).first<{ sent_at: number; through: number }>();
  if (state && row.created_at <= state.through) return {}; // an earlier email named it
  if (state && now - state.sent_at < NOTICE_WINDOW_MS) {
    const wait = Math.ceil((state.sent_at + NOTICE_WINDOW_MS - now) / 1000);
    await env.PLATFORM_QUEUE.send(envelope, { delaySeconds: Math.max(1, wait) });
    return {};
  }
  // The first notice names only this window's sign-ups, never the whole backfilled index.
  const through = state?.through ?? now - 2 * NOTICE_WINDOW_MS;
  const { results } = await env.INDEX.prepare(
    `SELECT a.account,a.created_at,a.provider,COALESCE(h.handle,a.handle) AS handle
       FROM platform_accounts a LEFT JOIN platform_handles h ON h.workspace=a.account
      WHERE a.created_at>? ORDER BY a.created_at DESC`,
  )
    .bind(through)
    .all<SignUp>();
  if (!results.length) return {};
  const newest = results[0].created_at;
  // The key names the sign-ups the email covers: a redelivery covers the same ones.
  const names = results.map((r) => r.account);
  const key = await resendKey(env);
  if (!key) return {};
  const email = renderNotice(settings.origin, results);
  let answer: Response;
  try {
    answer = await send(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `admin-signup/${await digest([settings.origin, ...names].join('\n'))}`,
      },
      body: JSON.stringify({ from: settings.from, to: [settings.to], ...email }),
    });
  } catch (e: any) {
    return failed(attempts, true, { error: String(e?.message ?? e).slice(0, 200) });
  }
  if (!answer.ok) {
    const body = await answer.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    return failed(attempts, transient(answer.status, body.name), {
      status: answer.status,
      name: body.name,
    });
  }
  await env.INDEX.prepare(
    `INSERT INTO admin_notices(kind,sent_at,through) VALUES('signup',?,?)
     ON CONFLICT(kind) DO UPDATE SET sent_at=excluded.sent_at,through=MAX(through,excluded.through)`,
  )
    .bind(now, newest)
    .run();
  return {};
}

function failed(attempts: number, again: boolean, detail: Record<string, unknown>) {
  if (attempts < MAX_ATTEMPTS && again) return { retry: backoff(attempts) };
  console.error(JSON.stringify({ event: 'email.signup_notice.failed', attempts, ...detail }));
  return {};
}

const nameOf = (s: SignUp) => s.handle ?? s.account;
const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The notice: the newest sign-up first, then up to LISTED more and a count of the rest. */
export function renderNotice(origin: string, signups: SignUp[]) {
  const [first, ...rest] = signups;
  const link = (s: SignUp) => `${origin}/admin/users/${encodeURIComponent(s.account)}`;
  const how = (s: SignUp) =>
    `via ${PROVIDER_LABEL[s.provider] ?? s.provider}, ${when(s.created_at)}`;
  const line = (s: SignUp) => `${nameOf(s)}, ${how(s)}`;
  const named = (s: SignUp) =>
    `<a href="${escapeHtml(link(s))}">${escapeHtml(nameOf(s))}</a>, ${escapeHtml(how(s))}`;
  const more = rest.length ? ` +${rest.length} more` : '';
  const listed = rest.slice(0, LISTED);
  const unlisted = rest.length - listed.length;
  const text = [
    `New sign-up on ${origin}:`,
    '',
    line(first),
    link(first),
    ...(rest.length ? ['', `+${rest.length} more:`, ...listed.map((s) => `- ${line(s)}`)] : []),
    ...(unlisted ? [`- and ${unlisted} others`] : []),
    '',
    `All sign-ups: ${origin}/admin/signups`,
  ].join('\n');
  const html = [
    `<p>New sign-up on ${escapeHtml(origin)}:</p>`,
    `<p>${named(first)}</p>`,
    ...(rest.length
      ? [
          `<p>+${rest.length} more:</p><ul>${listed.map((s) => `<li>${named(s)}</li>`).join('')}</ul>`,
        ]
      : []),
    ...(unlisted ? [`<p>and ${unlisted} others</p>`] : []),
    `<p><a href="${escapeHtml(`${origin}/admin/signups`)}">All sign-ups</a></p>`,
  ].join('\n');
  return { subject: `New sign-up: ${nameOf(first)}${more}`, text, html };
}
