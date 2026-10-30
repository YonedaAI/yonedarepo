// The welcome email through the real account authority (workerd) with Resend's endpoint
// stubbed: sign-up asks the platform (its entrypoint method, as the front does over its
// service binding) to queue one job, the consumer's request, redelivery, missing config, and
// retry versus give-up by Resend's answer. No real Resend calls.
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { PlatformEntrypoint, platformJob } from '../../cloudflare/worker/platform-entrypoint';
import {
  maskAddress,
  RESEND_EMAILS,
  welcomeJob,
} from '../../cloudflare/worker/platform-welcome-email';
import {
  renderVerify,
  renderWelcome,
  WELCOME_DOCS,
} from '../../cloudflare/worker/platform-welcome-template';
import { sha } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const queued: Envelope[] = [];
const fakeQueue = { send: async (body: Envelope) => void queued.push(body) };
afterEach(() => void queued.splice(0));
/** The Secrets Store binding: counts reads, so the key is shown to be read at send time. */
const keyReads = { count: 0 };
const storeKey = (value: () => string) => ({
  get: async () => {
    keyReads.count++;
    return value();
  },
});
afterEach(() => void (keyReads.count = 0));
const configured: Partial<Env> = {
  RESEND_API_KEY: storeKey(() => 're_test_key'),
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  EMAIL_CONTACT: 'hello@yonedarepo.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
};
/** A front-like env: no queue of its own, the platform's entrypoint behind PLATFORM. The
 * platform side runs with the recording queue. */
const scoped = (extra: Partial<Env> = {}) => {
  const platformEnv = { ...bindings, PLATFORM_QUEUE: fakeQueue, ...extra } as unknown as Env;
  const platform = new PlatformEntrypoint(createExecutionContext(), platformEnv);
  return { ...platformEnv, PLATFORM_QUEUE: undefined, PLATFORM: platform } as unknown as Env;
};

/** A sign-up gives `email` (the account name when it is an address); null leaves it out. */
async function auth(
  target: Env,
  action: string,
  username: string,
  email: string | null = username.includes('@') ? username : `${username}@example.com`,
) {
  const req = new Request(`https://yoneda/api/auth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'a long test password',
      ...(action === 'signup' && email !== null ? { email } : {}),
    }),
  });
  return (await accountRoute(req, target)) as Response;
}

/** Resend's endpoint: records each request and answers with the next scripted response. */
function resend(answers: { status: number; name?: string }[] = []) {
  const got: { url: string; headers: Headers; json: any }[] = [];
  const send = (async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    got.push({ url: req.url, headers: req.headers, json: await req.json() });
    const next = answers.shift() ?? { status: 200 };
    const body = next.status === 200 ? { id: 'email-1' } : { name: next.name ?? 'application_error' };
    return Response.json(body, { status: next.status });
  }) as typeof fetch;
  return { got, send };
}

it('renders the confirmation link in the welcome email and its own email (snapshots)', async () => {
  const config = { origin: 'https://yonedarepo.com', contact: 'hello@yonedarepo.com' };
  const verifyUrl = `https://yonedarepo.com/verify-email?account=ada&token=${'ab'.repeat(32)}`;
  const welcome = renderWelcome({ ...config, verifyUrl });
  await expect(welcome.text).toMatchFileSnapshot('./__snapshots__/welcome-email-confirm.txt');
  const confirm = renderVerify({ ...config, verifyUrl });
  expect(confirm.subject).toBe('Confirm your email for YonedaRepo');
  await expect(confirm.text).toMatchFileSnapshot('./__snapshots__/confirm-email.txt');
  await expect(confirm.html).toMatchFileSnapshot('./__snapshots__/confirm-email.html');
  for (const email of [welcome, confirm]) {
    expect(email.text).toContain(verifyUrl);
    expect(email.html).toContain(`href="${verifyUrl.replaceAll('&', '&amp;')}"`);
    expect(email.text).toContain('The link works once, for 24 hours.');
  }
});

it('renders the welcome email (text and HTML snapshots)', async () => {
  const email = renderWelcome({ origin: 'https://yonedarepo.com', contact: 'hello@yonedarepo.com' });
  expect(email.subject).toBe('Welcome to YonedaRepo');
  await expect(email.text).toMatchFileSnapshot('./__snapshots__/welcome-email.txt');
  await expect(email.html).toMatchFileSnapshot('./__snapshots__/welcome-email.html');
  for (const path of Object.values(WELCOME_DOCS)) {
    expect(email.text).toContain(`https://yonedarepo.com${path}`);
    expect(email.html).toContain(`href="https://yonedarepo.com${path}"`);
  }
  // No images, pixels or rewritten links; config is escaped.
  expect(email.html).not.toMatch(/<img|background/i);
  const hostile = renderWelcome({ origin: 'https://x.test"><script>', contact: 'a<b>@x.test' });
  expect(hostile.html).not.toContain('<script>');
  expect(hostile.html).not.toContain('a<b>');
});

it('enqueues exactly one welcome job when an account is created, and none otherwise', async () => {
  const target = scoped();
  // The front has no queue: the platform's entrypoint queues the job.
  expect(target.PLATFORM_QUEUE).toBeUndefined();
  expect((await auth(target, 'signup', 'ada@example.com')).status).toBe(200);
  expect(queued).toEqual([
    {
      v: 1,
      kind: 'account_welcome',
      repo_id: '',
      job_id: 'welcome',
      workspace: 'ada@example.com',
      token: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  ]);
  // A username account's welcome goes to its contact email.
  expect((await auth(target, 'signup', 'ada_user', 'Ada.Lovelace@Example.org')).status).toBe(200);
  expect(queued[1]).toMatchObject({ workspace: 'ada_user' });
  // The job names the account only; the address comes from the account authority.
  expect(JSON.stringify(queued)).not.toContain('lovelace');
  expect(await workspace(target, 'ada_user', { op: 'welcome_state' })).toEqual({
    sent: false,
    email: 'ada.lovelace@example.org',
  });
  // A repeated sign-up and a login add nothing; a sign-up without a valid email is refused
  // and creates no account.
  expect((await auth(target, 'signup', 'ada@example.com')).status).toBe(400);
  expect((await auth(target, 'login', 'ada@example.com')).status).toBe(200);
  for (const email of [null, '', 'not-an-address', 'a@b']) {
    const refused = await auth(target, 'signup', 'no_email', email);
    expect(refused.status, String(email)).toBe(400);
    expect((await refused.json<any>()).error.message).toMatch(/email/i);
  }
  expect((await auth(target, 'login', 'no_email')).status).toBe(401);
  expect(queued).toHaveLength(2);
});

it('posts the welcome email to Resend with its key and a per-account idempotency key', async () => {
  const target = scoped(configured);
  await auth(target, 'signup', 'grace@example.com');
  const { got, send } = resend();
  expect(keyReads.count).toBe(0);
  expect(await welcomeJob(target, queued[0], 1, send)).toEqual({});
  expect(keyReads.count).toBe(1);
  expect(got).toHaveLength(1);
  const [request] = got;
  expect(request.url).toBe(RESEND_EMAILS);
  expect(request.headers.get('authorization')).toBe('Bearer re_test_key');
  expect(request.headers.get('content-type')).toBe('application/json');
  const key = request.headers.get('idempotency-key');
  // Scoped to the deployment's origin: dev and prod share one Resend account, and the same
  // username in both must not collide inside Resend's 24-hour idempotency window.
  expect(key).toBe(`welcome/${await sha('https://yonedarepo.test\ngrace@example.com')}`);
  expect(key).not.toBe(`welcome/${await sha('grace@example.com')}`);
  expect(key).not.toContain('grace');
  // The confirmation link carries the job's token.
  const email = renderWelcome({
    origin: 'https://yonedarepo.test',
    contact: 'hello@yonedarepo.test',
    verifyUrl: `https://yonedarepo.test/verify-email?account=grace%40example.com&token=${queued[0].token}`,
  });
  expect(request.json).toEqual({
    from: 'YonedaRepo <hello@yonedarepo.test>',
    to: ['grace@example.com'],
    reply_to: 'hello@yonedarepo.test',
    subject: 'Welcome to YonedaRepo',
    text: email.text,
    html: email.html,
  });
});

it('does not send twice when the job is redelivered', async () => {
  const target = scoped(configured);
  await auth(target, 'signup', 'lin@example.com');
  const { got, send } = resend();
  const settled: string[] = [];
  const deliver = (attempts: number) =>
    welcomeJob(target, queued[0], attempts, send).then((o) => settled.push(JSON.stringify(o)));
  await deliver(1);
  await deliver(2);
  expect(got).toHaveLength(1);
  expect(settled).toEqual(['{}', '{}']);
});

it('skips the send when email is not configured, and sign-up still succeeds', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = scoped({ RESEND_API_KEY: undefined, EMAIL_FROM: 'YonedaRepo <a@b.test>' });
  expect((await auth(target, 'signup', 'off@example.com')).status).toBe(200);
  const { got, send } = resend();
  expect(await welcomeJob(target, queued[0], 1, send)).toEqual({});
  expect(await welcomeJob(target, queued[0], 2, send)).toEqual({});
  expect(got).toHaveLength(0);
  // Logged at most once per isolate, with names only.
  expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('a@b.test');
  // The deployed sign-up path (no Resend config in the test Worker) answers 200 as well.
  const res = await bindings.SELF.fetch('https://yoneda/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'self', email: 'self@example.com', password: 'a long test password' }),
  });
  expect(res.status).toBe(200);
});

it('treats an unreadable or empty Secrets Store key as email off, without logging it', async () => {
  const logs = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  for (const [i, key] of [
    storeKey(() => {
      throw new Error('store unavailable re_leaked_value');
    }),
    storeKey(() => ''),
  ].entries()) {
    const target = scoped({ ...configured, RESEND_API_KEY: key });
    expect((await auth(target, 'signup', `nokey${i}@example.com`)).status).toBe(200);
    const { got, send } = resend();
    expect(await welcomeJob(target, queued[i], 1, send)).toEqual({});
    expect(got).toHaveLength(0);
  }
  expect(keyReads.count).toBe(2);
  expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain('re_leaked_value');
});

it('retries a 5xx with backoff through the queue job, and stops on a 4xx', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const target = scoped(configured);
  await auth(target, 'signup', 'retry@example.com');
  const job = queued[0];
  const { got, send } = resend([
    { status: 503, name: 'service_unavailable' },
    { status: 429, name: 'rate_limit_exceeded' },
    { status: 409, name: 'concurrent_idempotent_requests' },
    { status: 500 },
  ]);
  const outcomes = [];
  for (const attempts of [1, 2, 3, 4]) outcomes.push(await welcomeJob(target, job, attempts, send));
  expect(outcomes).toEqual([{ retry: 30 }, { retry: 120 }, { retry: 480 }, {}]);
  expect(got).toHaveLength(4);
  // The last attempt gives up: logged once, without the address in full.
  expect(error).toHaveBeenCalledTimes(1);
  const logged = String(error.mock.calls[0][0]);
  expect(JSON.parse(logged)).toMatchObject({ event: 'email.welcome.failed', to: maskAddress('retry@example.com'), status: 500 });
  expect(logged).not.toContain('retry@example.com');

  // A permanent 4xx stops at once.
  await auth(target, 'signup', 'bad@example.com');
  const refused = resend([{ status: 422, name: 'validation_error' }]);
  const message = { body: queued[1], attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await welcomeJob(target, queued[1], 1, refused.send);
  expect(refused.got).toHaveLength(1);
  expect(error).toHaveBeenCalledTimes(2);
  expect(String(error.mock.calls[1][0])).not.toContain('bad@example.com');

  // Through the consumer: a 5xx becomes a delayed retry, not an ack.
  const original = globalThis.fetch;
  globalThis.fetch = resend([{ status: 502 }]).send;
  try {
    await platformJob(target, message as unknown as Message<Envelope>);
  } finally {
    globalThis.fetch = original;
  }
  expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  expect(message.ack).not.toHaveBeenCalled();
});

it('sends nothing for an account without a contact email', async () => {
  const target = scoped(configured);
  // As an OAuth account with no verified address (or one made before the field) is stored.
  await workspace(target, 'no_contact', {
    op: 'identity_signup',
    username: 'no_contact',
    provider: 'github',
    subject: '42',
    login: 'no_contact',
    session_hash: 'a'.repeat(64),
  });
  const { got, send } = resend();
  const job: Envelope = { v: 1, kind: 'account_welcome', repo_id: '', job_id: 'welcome', workspace: 'no_contact' };
  expect(await welcomeJob(target, job, 1, send)).toEqual({});
  expect(got).toHaveLength(0);
});

it('serves accountCreated as an entrypoint method (RPC), not over HTTP', async () => {
  // The combined Worker's own entrypoint, the way the platform reaches itself over SELF.
  const self = bindings.SELF as unknown as { accountCreated(account: string): Promise<void> };
  expect((await auth(scoped(), 'signup', 'rpc_only')).status).toBe(200);
  await expect(self.accountCreated('rpc_only')).resolves.toBeUndefined();
  const res = await bindings.SELF.fetch('https://yoneda/api/accountCreated', { method: 'POST' });
  expect(res.status).toBe(404);
});
