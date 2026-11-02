// Forgot password by email through the real account authority (workerd), with Resend's endpoint
// stubbed: one answer for every asker, the emailed link, the reset's effects, the limits, and a
// new recovery code from Settings. No real Resend calls.
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { withWaitUntil } from '../../cloudflare/worker/background';
import { PlatformEntrypoint, platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { passwordResetJob } from '../../cloudflare/worker/platform-password-email';
import { isPublicPage } from '../../cloudflare/worker/site-events';
import { websitePage } from '../../cloudflare/worker/website-metadata';
import { renderPasswordReset } from '../../cloudflare/worker/platform-welcome-template';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
const queued: Envelope[] = [];
afterEach(async () => {
  queued.splice(0);
  await reset();
  vi.restoreAllMocks();
});
const PASSWORD = 'a long test password';
const NEW_PASSWORD = 'a brand new password';
const configured: Partial<Env> = {
  RESEND_API_KEY: { get: async () => 're_test_key' },
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  EMAIL_CONTACT: 'hello@yonedarepo.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
};
type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
/** A front-like env whose PLATFORM is the platform entrypoint, as account-email-verify.test.ts. */
function front(limiter?: Limiter) {
  const platformEnv = {
    ...bindings,
    ...configured,
    AUTH_LIMITER: limiter,
    PLATFORM_QUEUE: {
      send: async (body: Envelope) =>
        void (body.kind !== 'admin_signup_notice' && queued.push(body)),
    },
  } as unknown as Env;
  const platform = new PlatformEntrypoint(createExecutionContext(), platformEnv);
  return { ...platformEnv, PLATFORM_QUEUE: undefined, PLATFORM: platform } as unknown as Env;
}
async function call(
  target: Env,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = new Request(`https://yoneda/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = (await accountRoute(req, target)) as Response;
  return { status: res.status, body: await res.json<any>(), headers: res.headers };
}
const cookieOf = (headers: Headers) => (headers.get('set-cookie') ?? '').split(';')[0];
/** An account by email sign-up: its cookie and recovery code. */
async function signup(target: Env, name: string) {
  const made = await call(target, 'signup', {
    email: `${name}@example.com`,
    password: PASSWORD,
  });
  expect(made.status).toBe(200);
  return { cookie: cookieOf(made.headers), code: made.body.recovery_code as string };
}
/** Confirms the address with the welcome email's token. */
async function confirm(target: Env, name: string) {
  const job = queued.findLast((j) => j.kind === 'account_welcome' && j.workspace === name);
  expect((await call(target, 'email/verify', { account: name, token: job?.token })).status).toBe(
    200,
  );
}
async function confirmed(target: Env, name: string) {
  const made = await signup(target, name);
  await confirm(target, name);
  return made;
}
const jobs = () => queued.filter((j) => j.kind === 'account_password_reset');
/** Runs the job against the stubbed Resend; returns what was posted, if anything. */
async function deliver(target: Env, job: Envelope, answer?: Response) {
  const got: any[] = [];
  const send = (async (_url: RequestInfo, init?: RequestInit) => {
    got.push({
      ...JSON.parse(String(init?.body)),
      idempotency: new Headers(init?.headers).get('idempotency-key'),
    });
    return answer ?? Response.json({ id: 'email-1' });
  }) as typeof fetch;
  const outcome = await passwordResetJob(target, job, 1, send);
  return { sent: got[0] as Record<string, any> | undefined, outcome };
}
const FRAGMENT =
  /https:\/\/yonedarepo\.test\/reset-password#account=([^&\s"]+)&(?:amp;)?token=([0-9a-f]{64})/;
function linkIn(text: string) {
  const match = text.match(FRAGMENT);
  expect(match, text).toBeTruthy();
  return { account: decodeURIComponent(match?.[1] ?? ''), token: match?.[2] ?? '' };
}
/** A confirmed account, asked for a reset: its link's parts and what it signed up with. */
async function requested(target: Env, name: string) {
  const made = await confirmed(target, name);
  expect((await call(target, 'password/forgot', { username: name })).status).toBe(200);
  const job = jobs().at(-1) as Envelope;
  const { sent } = await deliver(target, job);
  return { ...made, ...linkIn(sent?.text ?? '') };
}
const sessionOf = async (target: Env, cookie: string) =>
  (await call(target, 'session', undefined, { cookie })).body.authenticated;

it('answers every asker the same line and writes only to a confirmed address', async () => {
  const target = front();
  await confirmed(target, 'carla');
  await signup(target, 'dmitri'); // unconfirmed
  const before = queued.length;
  const answers = [];
  for (const username of [
    'carla',
    'carla@example.com',
    'dmitri',
    'dmitri@example.com',
    'nobody_here',
    'nobody@example.com',
    'not a valid name!',
    '',
    42,
  ])
    answers.push(await call(target, 'password/forgot', { username }));
  answers.push(await call(target, 'password/forgot', {}));
  for (const answer of answers) {
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(answers[0].body);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('set-cookie')).toBeNull();
  }
  // Two jobs: the name and the address both reach carla, and only carla.
  expect(queued.length - before).toBe(2);
  expect(jobs().map((j) => j.workspace)).toEqual(['carla', 'carla']);
});

it('answers before any account work when the request lends its waitUntil', async () => {
  const target = front();
  await confirmed(target, 'grace');
  const started: string[] = [];
  const platform = target.PLATFORM as unknown as { passwordReset: (a: string) => Promise<void> };
  const slow = {
    ...target,
    PLATFORM: {
      passwordReset: (account: string) => {
        started.push(account);
        return platform.passwordReset(account);
      },
    },
  } as unknown as Env;
  const waiting: Promise<unknown>[] = [];
  const answer = await withWaitUntil(
    (work) => void waiting.push(work),
    () => call(slow, 'password/forgot', { username: 'grace' }),
  );
  expect(answer.status).toBe(200);
  expect(waiting).toHaveLength(1);
  await Promise.all(waiting);
  expect(started).toEqual(['grace']);
});

it('emails a single-use link with the token only in the fragment, once per token', async () => {
  const target = front();
  await confirmed(target, 'helen');
  await call(target, 'password/forgot', { username: 'helen@example.com' });
  const job = jobs()[0];
  expect(job.token).toMatch(/^[0-9a-f]{64}$/);
  const { sent, outcome } = await deliver(target, job);
  expect(outcome).toEqual({});
  expect(sent?.to).toEqual(['helen@example.com']);
  expect(sent?.subject).toBe('Reset your YonedaRepo password');
  expect(sent?.reply_to).toBe('hello@yonedarepo.test');
  expect(linkIn(sent?.text)).toEqual({ account: 'helen', token: job.token });
  expect(sent?.text).toContain('The link works once, for 1 hour.');
  expect(linkIn(sent?.html).token).toBe(job.token);
  // Nothing before the fragment names the account or the token.
  expect(String(sent?.text).match(FRAGMENT)?.[0].split('#')[0]).toBe(
    'https://yonedarepo.test/reset-password',
  );
  // The idempotency key is neither the token nor the address.
  expect(sent?.idempotency).not.toContain(job.token);
  expect(sent?.idempotency).not.toContain('helen');
});

it('sends nothing once the link cannot work, and retries only what may pass', async () => {
  const target = front();
  const { account, token } = await requested(target, 'irene');
  const job = jobs()[0];
  const flaky = await deliver(target, job, Response.json({ name: 'rate_limit' }, { status: 429 }));
  expect(flaky.outcome).toEqual({ retry: 30 });
  await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect((await deliver(target, job)).sent).toBeUndefined();
  // A job with no token is nothing.
  expect((await deliver(target, { ...job, token: undefined })).sent).toBeUndefined();
});

it('runs the queue job through the platform dispatcher', async () => {
  const target = front();
  await confirmed(target, 'joan');
  await call(target, 'password/forgot', { username: 'joan' });
  const message = { body: jobs()[0], attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await platformJob(
    { ...target, RESEND_API_KEY: undefined } as unknown as Env,
    message as never,
  );
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
});

it('a link sets the password, ends sessions, kills the old code and works once', async () => {
  const target = front();
  const { account, token, cookie, code } = await requested(target, 'katya');
  expect(await sessionOf(target, cookie)).toBe(true);
  const done = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect(done.status).toBe(200);
  expect(done.body.recovery_code).toMatch(/^[0-9a-f]{64}$/);
  expect(done.body.recovery_code).not.toBe(code);
  expect(done.headers.get('cache-control')).toBe('no-store');
  // No session comes with it: the page leads to sign-in.
  expect(cookieOf(done.headers)).toBe('yoneda_account=');
  expect(await sessionOf(target, cookie)).toBe(false);
  expect((await call(target, 'login', { username: account, password: PASSWORD })).status).toBe(401);
  const signedIn = await call(target, 'login', { username: account, password: NEW_PASSWORD });
  expect(signedIn.status).toBe(200);
  const old = await call(target, 'recover', {
    username: account,
    password: 'another long password',
    recovery_code: code,
  });
  expect(old.status).toBe(401);
  const fresh = await call(target, 'recover', {
    username: account,
    password: 'another long password',
    recovery_code: done.body.recovery_code,
  });
  expect(fresh.status).toBe(200);
  const reused = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect(reused.status).toBe(400);
  expect(reused.body.error.code).toBe('INVALID_TOKEN');
  expect(reused.body.recovery_code).toBeUndefined();
});

it('revokes tokens with the reset, so a takeover leaves nothing behind', async () => {
  const target = front();
  const { account, token } = await requested(target, 'zora');
  await workspace(target, account, {
    op: 'pat_create',
    id: 'pat_0123456789abcdef',
    name: 'ci',
    token_hash: 'c'.repeat(64),
    scopes: ['repo:read'],
    expires_days: 30,
    repos: null,
  });
  const check = () => workspace(target, account, { op: 'pat_check', token_hash: 'c'.repeat(64) });
  expect((await check()).id).toBe('pat_0123456789abcdef');
  expect((await call(target, 'password/reset', { account, token, password: NEW_PASSWORD })).status).toBe(200);
  await expect(check()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

it('leaves an audit event without a secret in it', async () => {
  const target = front();
  const { account, token } = await requested(target, 'lena');
  const done = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  const rows = await runInDurableObject(
    bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:lena')),
    (_, state) =>
      state.storage.sql
        .exec<{ kind: string; data: string }>('SELECT kind,data FROM workspace_events')
        .toArray(),
  );
  const row = rows.find((r) => r.kind === 'account.password_reset');
  expect(row).toBeTruthy();
  const all = JSON.stringify(rows);
  for (const secret of [token, done.body.recovery_code, NEW_PASSWORD])
    expect(all).not.toContain(secret);
});

it('refuses an expired link, and keeps the old password', async () => {
  const target = front();
  const { account, token, cookie } = await requested(target, 'maria');
  await runInDurableObject(
    bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('account:maria')),
    (_, state) => {
      state.storage.sql.exec(
        "UPDATE workspace_records SET payload=json_set(payload,'$.expires',1) WHERE id LIKE 'reset_token:%'",
      );
    },
  );
  const late = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect(late.status).toBe(400);
  expect(late.body.error.code).toBe('INVALID_TOKEN');
  expect(await sessionOf(target, cookie)).toBe(true);
  expect((await call(target, 'login', { username: account, password: PASSWORD })).status).toBe(200);
});

it('refuses a link by the same words whatever is wrong with it', async () => {
  const target = front();
  const { account, token } = await requested(target, 'nadia');
  const answers = await Promise.all(
    [
      { account, token: '0'.repeat(64) },
      { account, token: 'x' },
      { account: 'nobody_here', token },
      { account: 'not a name!', token },
      { token },
      {},
    ].map((body) => call(target, 'password/reset', { ...body, password: NEW_PASSWORD })),
  );
  for (const answer of answers) {
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(answers[0].body);
  }
  // Opening the link's address on the API changes nothing.
  expect((await call(target, `password/reset?account=${account}&token=${token}`)).status).toBe(404);
});

it('keeps the link when the new password is refused', async () => {
  const target = front();
  const { account, token } = await requested(target, 'olga');
  for (const password of ['too short', 'x'.repeat(129), 42]) {
    const refused = await call(target, 'password/reset', { account, token, password });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/12.128/);
  }
  const done = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect(done.status).toBe(200);
});

it('tells a suspended account so only with a working link', async () => {
  const target = front();
  const { account, token } = await requested(target, 'petra');
  await workspace(target, account, { op: 'account_suspend' });
  const refused = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe('ACCOUNT_SUSPENDED');
  const guess = await call(target, 'password/reset', {
    account,
    token: '0'.repeat(64),
    password: NEW_PASSWORD,
  });
  expect(guess.body.error.code).toBe('INVALID_TOKEN');
});

it('limits links to five a day per account, in the same words', async () => {
  const target = front();
  await confirmed(target, 'quinn');
  const answers = [];
  for (let i = 0; i < 7; i++)
    answers.push(await call(target, 'password/forgot', { username: 'quinn' }));
  for (const answer of answers) expect(answer).toMatchObject({ status: 200, body: answers[0].body });
  expect(jobs()).toHaveLength(5);
});

it('limits by caller address with a refusal that says nothing about the account', async () => {
  const keys: string[] = [];
  const limiter: Limiter = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success: !key.startsWith('forgot:') };
    },
  };
  const target = front(limiter);
  await confirmed(target, 'rosa');
  keys.splice(0);
  const asked = (username: string) =>
    call(target, 'password/forgot', { username }, { 'cf-connecting-ip': '192.0.2.7' });
  const known = await asked('rosa');
  const unknown = await asked('nobody_here');
  expect(known.status).toBe(429);
  expect(unknown).toMatchObject({ status: 429, body: known.body });
  expect(keys).toEqual(['forgot:192.0.2.7', 'forgot:192.0.2.7']);
  expect(jobs()).toHaveLength(0);
});

it('limits by account and by email address without changing the answer', async () => {
  for (const refused of ['reset-account:', 'reset-email:']) {
    const keys: string[] = [];
    const limiter: Limiter = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: !key.startsWith(refused) };
      },
    };
    const target = front(limiter);
    const name = refused === 'reset-account:' ? 'sofia' : 'tessa';
    await confirmed(target, name);
    const answer = await call(target, 'password/forgot', { username: name });
    const stranger = await call(target, 'password/forgot', { username: 'nobody_here' });
    expect(answer).toMatchObject({ status: 200, body: stranger.body });
    expect(jobs()).toHaveLength(0);
    expect(keys.some((key) => key.startsWith(refused))).toBe(true);
    // The email address stays out of the limiter's key.
    expect(keys.join()).not.toContain('@');
  }
});

it('survives a platform failure with the same answer and no secret in the log', async () => {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
  const target = front();
  await confirmed(target, 'uma');
  const failing = {
    ...target,
    PLATFORM: {
      passwordReset: async () => {
        throw new Error('platform down');
      },
    },
  } as unknown as Env;
  const answer = await call(failing, 'password/forgot', { username: 'uma@example.com' });
  expect(answer.status).toBe(200);
  expect(lines.join('\n')).not.toContain('uma@example.com');
});

it('logs no token, password or recovery code through a whole reset', async () => {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
  const target = front();
  const { account, token } = await requested(target, 'vera');
  const done = await call(target, 'password/reset', { account, token, password: NEW_PASSWORD });
  const all = lines.join('\n');
  for (const secret of [token, done.body.recovery_code, NEW_PASSWORD])
    expect(all).not.toContain(secret);
});

it('regenerates the recovery code for a signed-in person, once, and refuses tokens', async () => {
  const target = front();
  const { cookie, code } = await signup(target, 'wanda');
  expect((await call(target, 'recovery-code', {})).status).toBe(401);
  // A token never stands in for the browser session, even beside a cookie.
  const made = await workspace(target, 'wanda', {
    op: 'pat_create',
    id: 'pat_0123456789abcdef',
    name: 'ci',
    token_hash: 'c'.repeat(64),
    scopes: ['repo:read'],
    expires_days: 30,
    repos: null,
  });
  expect(made.id).toBeTruthy();
  const bearer = { authorization: `Bearer yoneda_pat_${'c'.repeat(40)}` };
  expect((await call(target, 'recovery-code', {}, bearer)).status).toBe(401);
  expect((await call(target, 'recovery-code', {}, { ...bearer, cookie })).status).toBe(401);
  // The same cookie refused above still works, and only by POST.
  expect((await call(target, 'recovery-code', undefined, { cookie })).status).toBe(404);
  const done = await call(target, 'recovery-code', {}, { cookie });
  expect(done.status).toBe(200);
  expect(done.body.recovery_code).toMatch(/^[0-9a-f]{64}$/);
  expect(done.headers.get('cache-control')).toBe('no-store');
  const recover = (recovery_code: string) =>
    call(target, 'recover', {
      username: 'wanda',
      password: NEW_PASSWORD,
      recovery_code,
    });
  expect((await recover(code)).status).toBe(401);
  expect((await recover(done.body.recovery_code)).status).toBe(200);
  // Recovery ended the session the code was made from.
  expect((await call(target, 'recovery-code', {}, { cookie })).status).toBe(401);
});

it('refuses a cross-site request for a new recovery code', async () => {
  const target = front();
  const { cookie } = await signup(target, 'xenia');
  const answer = await call(
    target,
    'recovery-code',
    {},
    { cookie, origin: 'https://evil.example' },
  );
  expect(answer.status).toBe(401);
});

it('keeps the reset page out of analytics and search', async () => {
  const page = new Response('<html><head></head></html>', {
    headers: { 'content-type': 'text/html' },
  });
  const req = new Request('https://yonedarepo.test/reset-password');
  expect(isPublicPage(req, page)).toBe(false);
  // The confirmation page holds a token the same way, and an old link in its query.
  const confirming = new Request(`https://yonedarepo.test/verify-email?account=a&token=${'a'.repeat(64)}`);
  expect(isPublicPage(confirming, page)).toBe(false);
  const { response } = await websitePage(req, {
    ...bindings,
    ASSETS: { fetch: async () => page.clone() },
    SEO_INDEXING: 'on',
  } as unknown as Env);
  expect((await response.text()).toLowerCase()).toContain('noindex');
});

it('renders the reset email (text and HTML snapshots)', async () => {
  const resetUrl = `https://yonedarepo.com/reset-password#account=ada&token=${'ab'.repeat(32)}`;
  const email = renderPasswordReset({
    origin: 'https://yonedarepo.com',
    contact: 'hello@yonedarepo.com',
    resetUrl,
  });
  await expect(email.text).toMatchFileSnapshot('./__snapshots__/password-reset-email.txt');
  await expect(email.html).toMatchFileSnapshot('./__snapshots__/password-reset-email.html');
  expect(email.text).toContain(resetUrl);
  expect(email.html).toContain(`href="${resetUrl.replaceAll('&', '&amp;')}"`);
});
