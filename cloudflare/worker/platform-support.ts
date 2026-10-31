// `POST /api/v1/support`: the account menu's Contact support. A person signed in on the website
// (never a token) sends one text-only email to SUPPORT_EMAIL through Resend, whose reply goes
// to the address on the account. Five a day per account: the account authority counts a
// request before its email goes out (no answer from it, no email) and gives the slot back
// when the email could not be sent, so the person can repeat the same request. Resend's
// Idempotency-Key (24 hours) is the email's digest: a repeat after a lost answer sends nothing
// twice. The message is untrusted: plain text only, and one line of it in the subject.
import { fileSize, SUPPORT_MESSAGE_LIMIT } from '../../shared/support';
import { digest } from './platform-email-verify';
import { type Attachment, attachmentOf } from './platform-support-attachment';
import { maskAddress, RESEND_EMAILS, resendKey } from './platform-welcome-email';
import { ApiError, type Credentials, type Json } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

export { SUPPORT_BODY_LIMIT } from './platform-support-attachment';

/** Characters of the message the subject quotes. */
const SUBJECT_OPENING = 60;
const PAGE_LIMIT = 500;
/** Resend's slowest answer worth waiting for. A late one is what the key is for. */
const SEND_TIMEOUT_MS = 30_000;

const unavailable = () =>
  new ApiError(
    'SUPPORT_UNAVAILABLE',
    'The support form is not available right now. Email hello@yonedarepo.com instead.',
  );

function config(env: Env) {
  const to = env.SUPPORT_EMAIL?.trim();
  const from = env.EMAIL_FROM?.trim();
  const origin = env.WEB_ORIGIN?.trim().replace(/\/+$/, '');
  return to && from && origin && env.RESEND_API_KEY ? { to, from, origin } : null;
}

/** The account of a person's browser session: no token, script or agent writes to support. */
function personOf(auth: Credentials) {
  const session = '_session' in auth ? auth._session : null;
  if (!session?.human || session.principal !== `user:${session.workspace}`)
    throw new ApiError('FORBIDDEN', 'Sign in on the website to contact support');
  return session.workspace;
}

function messageOf(value: unknown) {
  // Line ends become \n and other control characters go; the rest stays the person's words.
  const message =
    typeof value === 'string'
      ? value
          .replace(/\r\n?/g, '\n')
          .replace(/[^\P{Cc}\n\t]/gu, '')
          .trim()
      : '';
  if (!message) throw new ApiError('INVALID_INPUT', 'Tell us what is going on first');
  if (message.length > SUPPORT_MESSAGE_LIMIT)
    throw new ApiError(
      'INVALID_INPUT',
      `A message can be up to ${SUPPORT_MESSAGE_LIMIT.toLocaleString('en-US')} characters`,
    );
  return message;
}

/** The page the request came from, always on this site; the client only says which. */
function pageOf(value: unknown, origin: string) {
  if (typeof value !== 'string' || !URL.canParse(value)) return 'unknown';
  const page = new URL(value);
  if (!/^https?:$/.test(page.protocol)) return 'unknown';
  return `${origin}${page.pathname}${page.search}`.slice(0, PAGE_LIMIT);
}

/** One line: no header survives into the subject. */
const oneLine = (text: string) => text.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();

/** What the account's row says, for support; a failed lookup only means a shorter email. */
async function factsOf(env: Env, account: string) {
  return env.INDEX.prepare(
    `SELECT COALESCE((SELECT handle FROM platform_handles WHERE workspace=?1),
                     (SELECT handle FROM platform_accounts WHERE account=?1)) AS handle,
            (SELECT COUNT(*) FROM platform_repos WHERE workspace=?1) AS repos`,
  )
    .bind(account)
    .first<{ handle: string | null; repos: number }>()
    .catch(() => null);
}

type SupportRequest = {
  account: string;
  reply: string;
  confirmed: boolean;
  handle?: string | null;
  repos?: number;
  page: string;
  message: string;
  attachment: Attachment | null;
};

function render(origin: string, request: SupportRequest) {
  const { account, reply, confirmed, handle, repos, page, message, attachment } = request;
  const opening = Array.from(oneLine(message)).slice(0, SUBJECT_OPENING).join('').trim();
  return {
    subject: oneLine(`Support: ${account} (${opening})`),
    text: [
      `Support request from ${origin}`,
      '',
      `Account: ${account}`,
      `Handle: ${handle ?? account}`,
      `Email: ${reply} (${confirmed ? 'confirmed' : 'not confirmed'})`,
      `Repositories: ${repos ?? 'unknown'}`,
      `Page: ${page}`,
      ...(attachment
        ? [
            `Attachment: ${attachment.filename} (${attachment.content_type}, ${fileSize(attachment.bytes)})`,
          ]
        : []),
      '',
      message,
    ].join('\n'),
  };
}

/** Sends `payload`; what went wrong, for the log, or null once Resend has it. */
async function deliver(key: string, payload: string) {
  try {
    const answer = await fetch(RESEND_EMAILS, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': `support/${await digest(payload)}`,
      },
      body: payload,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (answer.ok) return null;
    const body = await answer.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    return { status: answer.status, name: body.name };
  } catch (e: any) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function supportRoute(
  env: Env,
  auth: Credentials,
  body: () => Promise<Json>,
): Promise<Json> {
  const account = personOf(auth);
  const settings = config(env);
  if (!settings) throw unavailable();
  const input = await body();
  const message = messageOf(input.message);
  const attachment = attachmentOf(input.attachment);
  const contact = await workspace(env, account, { op: 'email_status' });
  const reply = typeof contact.email === 'string' ? contact.email : null;
  if (!reply)
    throw new ApiError('NO_EMAIL', 'Add an email address in Account settings so we can reply.');
  const key = await resendKey(env);
  if (!key) throw unavailable();
  const facts = await factsOf(env, account);
  const { admitted } = await workspace(env, account, { op: 'support_admit' });
  if (!admitted)
    throw new ApiError('RATE_LIMITED', 'You sent five requests today. Try again tomorrow.');
  const email = render(settings.origin, {
    account,
    reply,
    confirmed: Boolean(contact.verified),
    handle: facts?.handle,
    repos: facts?.repos,
    page: pageOf(input.page, settings.origin),
    message,
    attachment,
  });
  const failed = await deliver(
    key,
    JSON.stringify({
      from: settings.from,
      to: [settings.to],
      reply_to: reply,
      ...email,
      ...(attachment && {
        attachments: [
          {
            filename: attachment.filename,
            content: attachment.content,
            content_type: attachment.content_type,
          },
        ],
      }),
    }),
  );
  if (failed) {
    console.error(
      JSON.stringify({ event: 'email.support.failed', reply_to: maskAddress(reply), ...failed }),
    );
    await workspace(env, account, { op: 'support_release' }).catch(() => {});
    throw new ApiError('SUPPORT_SEND_FAILED', 'Your message was not sent. Try again in a moment.');
  }
  return { sent: true, email: reply };
}
