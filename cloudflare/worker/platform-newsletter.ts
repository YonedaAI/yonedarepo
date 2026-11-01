// The Flight log sign-up (`/api/v1/newsletter`, public, on the platform Worker because the front
// has no D1), double opt-in, behind NEWSLETTER. An email address is accepted the same way whether
// or not it is on the list: the row and the queue job happen for every valid request, and the job
// sends only if a live token is left to send, so neither the answer nor its timing says who
// signed up. For the same reason the limit per address is silent (no mail, same answer); the
// limit per client is the one that answers 429.
//
// Opening an emailed link changes nothing: a mail scanner follows links, so the page's button
// POSTs (as the account's confirmation does, account-email.ts). A mail client's one-click
// unsubscribe (RFC 8058) POSTs too. Unsubscribing keeps working with the switch off.
//
// A confirmation token is random, single use, and stored only as its digest. An unsubscribe link
// can't work that way: it must keep working from every mail, and the export must be able to
// print it, so it is the row's id signed with NEWSLETTER_KEY.
import { subscriberEmail } from '../../shared/newsletter';
import { hmacHex } from './hmac';
import { error, readJson, response } from './http';
import { audit } from './platform-admin-queries';
import { digest } from './platform-email-verify';
import { config } from './platform-welcome-email';
import { ApiError } from './repo-ops';
import { carriedQueue } from './request-scope';
import type { Env, Envelope, Json } from './types';

export const NEWSLETTER_JOB = 'newsletter_confirm';
/** How long a confirmation link works, and an unconfirmed address is kept. */
export const PENDING_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Confirmation emails one address gets in a day. */
const MAILS_A_DAY = 3;
const BODY_LIMIT = 1024;
const SWEEP_AT = { hour: 4, minute: 30 };
const PAGE = 200;

const TOKEN = /^[0-9a-f]{64}$/;
const SIGNED = /^([1-9][0-9]{0,15})\.([0-9a-f]{64})$/;
const LINK_INVALID = 'This link is invalid, used or expired. Sign up again to get a new one.';
const unknown = () => error('NOT_FOUND', 'Not available', 404);

/** Whether sign-ups are open: the switch, and everything a sent email needs. */
export const newsletterOn = (env: Env) =>
  env.NEWSLETTER === 'on' && Boolean(env.NEWSLETTER_KEY) && Boolean(config(env));

const signature = (key: string, id: number) => hmacHex(key, `newsletter-unsubscribe:${id}`);

/** The token in row `id`'s unsubscribe link; it never expires. */
export async function unsubscribeToken(env: Env, id: number) {
  return `${id}.${await signature(env.NEWSLETTER_KEY as string, id)}`;
}
export const confirmUrl = (origin: string, token: string) =>
  `${origin}/updates/confirm?token=${token}`;
export const unsubscribeUrl = (origin: string, token: string) =>
  `${origin}/updates/unsubscribe?token=${token}`;

const newToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** Whether this row may be sent another confirmation: not subscribed, and under the limit. */
const DUE =
  '(confirmed_at IS NULL OR unsubscribed_at IS NOT NULL) AND (mails<?5 OR mails_since<=?4)';

/** One statement, so two requests can't both pass the limit. A row that isn't due keeps its token,
 * which is what tells the job to send nothing. */
function remember(env: Env, email: string, tokenHash: string, now: number) {
  return env.INDEX.prepare(
    `INSERT INTO newsletter_subscribers(email,created_at,token_hash,token_at,mails_since)
       VALUES(?1,?2,?3,?2,?2)
     ON CONFLICT(email) DO UPDATE SET
       token_hash=CASE WHEN ${DUE} THEN excluded.token_hash ELSE token_hash END,
       token_at=CASE WHEN ${DUE} THEN excluded.token_at ELSE token_at END,
       mails=CASE WHEN NOT (${DUE}) THEN mails WHEN mails_since<=?4 THEN 1 ELSE mails+1 END,
       mails_since=CASE WHEN (${DUE}) AND mails_since<=?4 THEN ?2 ELSE mails_since END`,
  )
    .bind(email, now, tokenHash, now - DAY_MS, MAILS_A_DAY)
    .run();
}

async function signUp(req: Request, env: Env) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin)
    return error('FORBIDDEN', 'Sign up on the website', 403);
  const body = await readJson(req, BODY_LIMIT).catch(() => ({}) as Json);
  const email = subscriberEmail(body.email);
  if (!email) return error('INVALID_EMAIL', 'Enter a valid email address', 400);
  if (body.consent !== true)
    return error('CONSENT_REQUIRED', 'Tick the box to get updates by email', 400);
  const token = newToken();
  await remember(env, email, await digest(token), Date.now());
  const job: Envelope = { v: 1, kind: NEWSLETTER_JOB, repo_id: '', job_id: 'newsletter', token };
  await carriedQueue(env.PLATFORM_QUEUE).send(job);
  return response({ accepted: true }, 202);
}

async function confirm(req: Request, env: Env) {
  const body = await readJson(req, BODY_LIMIT).catch(() => ({}) as Json);
  const token = typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : null;
  if (!token) return error('INVALID_TOKEN', LINK_INVALID, 400);
  const now = Date.now();
  const changed = await env.INDEX.prepare(
    `UPDATE newsletter_subscribers SET confirmed_at=?1,unsubscribed_at=NULL,token_hash=NULL
      WHERE token_hash=?2 AND token_at>=?3`,
  )
    .bind(now, await digest(token), now - PENDING_MS)
    .run();
  return changed.meta.changes
    ? response({ confirmed: true })
    : error('INVALID_TOKEN', LINK_INVALID, 400);
}

/** The row a signed token names, or null. */
async function signedId(env: Env, token: unknown) {
  const match = typeof token === 'string' ? SIGNED.exec(token) : null;
  if (!match || !env.NEWSLETTER_KEY) return null;
  const id = Number(match[1]);
  const encoder = new TextEncoder();
  const same = crypto.subtle.timingSafeEqual(
    encoder.encode(await signature(env.NEWSLETTER_KEY, id)),
    encoder.encode(match[2]),
  );
  return same ? id : null;
}

async function unsubscribe(req: Request, env: Env) {
  // A mail client's one-click POST carries the link's query and a form body, not JSON.
  const body = await readJson(req, BODY_LIMIT).catch(() => ({}) as Json);
  const id = await signedId(env, new URL(req.url).searchParams.get('token') ?? body.token);
  if (id === null) return error('INVALID_TOKEN', 'This link is not valid.', 400);
  await env.INDEX.prepare(
    `UPDATE newsletter_subscribers SET unsubscribed_at=COALESCE(unsubscribed_at,?1),token_hash=NULL
      WHERE id=?2`,
  )
    .bind(Date.now(), id)
    .run();
  return response({ unsubscribed: true });
}

/** `/api/v1/newsletter[/<action>]`: anything this file doesn't name answers 404. */
export async function newsletterRoute(req: Request, env: Env): Promise<Response> {
  const action = new URL(req.url).pathname.slice('/api/v1/newsletter'.length);
  if (action === '' && req.method === 'GET') return response({ open: newsletterOn(env) });
  if (req.method !== 'POST' || !['', '/confirm', '/unsubscribe'].includes(action)) return unknown();
  if (action !== '/unsubscribe' && !newsletterOn(env)) return unknown();
  const client = req.headers.get('cf-connecting-ip') ?? 'local';
  if (env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key: `newsletter:${client}` })).success)
    return error('RATE_LIMITED', 'Too many tries. Wait a minute and try again.', 429);
  if (action === '/confirm') return confirm(req, env);
  if (action === '/unsubscribe') return unsubscribe(req, env);
  return signUp(req, env);
}

/** Once a night, forgets the addresses nobody confirmed. Runs with the switch off too, so what the
 * privacy policy promises doesn't depend on it. */
export async function sweepNewsletter(env: Env, at: number) {
  const time = new Date(at);
  if (time.getUTCHours() !== SWEEP_AT.hour || time.getUTCMinutes() !== SWEEP_AT.minute) return;
  await env.INDEX.prepare(
    'DELETE FROM newsletter_subscribers WHERE confirmed_at IS NULL AND token_at<?',
  )
    .bind(at - PENDING_MS)
    .run();
}

/** The overview's figure, or null while the list isn't in use. */
export async function subscriberCount(env: Env) {
  if (env.NEWSLETTER !== 'on') return null;
  const row = await env.INDEX.prepare(
    `SELECT COUNT(*) AS n FROM newsletter_subscribers
      WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`,
  ).first<{ n: number }>();
  return { confirmed: row?.n ?? 0 };
}

/** `GET admin/newsletter?after=`: a page of the confirmed list (`cargo xtask admin
 * newsletter-export`), each with the unsubscribe link a mail to them needs. Audited per page. */
export async function exportSubscribers(env: Env, actor: string, after: string | null) {
  const settings = config(env);
  if (!env.NEWSLETTER_KEY || !settings)
    throw new ApiError('NOT_FOUND', 'The list is not configured here');
  const from = Number(after);
  const { results } = await env.INDEX.prepare(
    `SELECT id,email,confirmed_at FROM newsletter_subscribers
      WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL AND id>? ORDER BY id LIMIT ?`,
  )
    .bind(Number.isSafeInteger(from) && from > 0 ? from : 0, PAGE)
    .all<{ id: number; email: string; confirmed_at: number }>();
  const subscribers = await Promise.all(
    results.map(async ({ id, email, confirmed_at }) => ({
      email,
      confirmed_at,
      unsubscribe_url: unsubscribeUrl(settings.origin, await unsubscribeToken(env, id)),
    })),
  );
  await audit(env, actor, 'newsletter.export', after || '-', { rows: subscribers.length });
  return { subscribers, next: results.length === PAGE ? String(results.at(-1)?.id) : null };
}
