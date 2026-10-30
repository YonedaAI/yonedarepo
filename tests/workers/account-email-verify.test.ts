// Contact-email verification through the real account authority (workerd), with Resend's
// endpoint stubbed: the welcome email's single-use link, confirming by POST only, resending
// and changing the address from Settings, and the resend limit. No real Resend calls.
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { accountRoute } from '../../cloudflare/worker/accounts';
import { PlatformEntrypoint } from '../../cloudflare/worker/platform-entrypoint';
import { welcomeJob } from '../../cloudflare/worker/platform-welcome-email';
import { sha } from '../../cloudflare/worker/storage';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
const queued: Envelope[] = [];
afterEach(async () => {
  queued.splice(0);
  await reset();
});
const configured: Partial<Env> = {
  RESEND_API_KEY: { get: async () => 're_test_key' },
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  EMAIL_CONTACT: 'hello@yonedarepo.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
};
/** A front-like env (no queue) whose PLATFORM is the platform entrypoint, with a recording
 * queue and Resend configured on the platform side. */
function front() {
  const platformEnv = {
    ...bindings,
    ...configured,
    PLATFORM_QUEUE: { send: async (body: Envelope) => void queued.push(body) },
  } as unknown as Env;
  const platform = new PlatformEntrypoint(createExecutionContext(), platformEnv);
  return { ...platformEnv, PLATFORM_QUEUE: undefined, PLATFORM: platform } as unknown as Env;
}

async function call(target: Env, path: string, body?: unknown, cookie?: string, method?: string) {
  const req = new Request(`https://yoneda/api/auth/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = (await accountRoute(req, target)) as Response;
  return { status: res.status, body: await res.json<any>(), headers: res.headers };
}
async function signup(target: Env, username: string, email = `${username}@example.com`) {
  // Sign-up is by email; the local part (a valid name) becomes the account's handle.
  const made = await call(target, 'signup', { email, password: 'a long test password' });
  expect(made.status).toBe(200);
  return (made.headers.get('set-cookie') ?? '').split(';')[0];
}
/** Runs one queued job against the stubbed Resend; returns what was posted, if anything. */
async function deliver(target: Env, job: Envelope) {
  const got: any[] = [];
  const send = (async (_url: RequestInfo, init?: RequestInit) => {
    got.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'email-1' });
  }) as typeof fetch;
  expect(await welcomeJob(target, job, 1, send)).toEqual({});
  return got[0] as { to: string[]; subject: string; text: string; html: string } | undefined;
}
const link = (text: string) => {
  const match = text.match(/https:\/\/yonedarepo\.test\/verify-email\?account=([^&\s]+)&token=([0-9a-f]{64})/);
  expect(match, text).toBeTruthy();
  return { account: decodeURIComponent(match?.[1] ?? ''), token: match?.[2] ?? '' };
};

it('puts a single-use link in the welcome email that verifies only by POST', async () => {
  const target = front();
  await signup(target, 'vera');
  expect(queued).toHaveLength(1);
  const sent = await deliver(target, queued[0]);
  expect(sent?.to).toEqual(['vera@example.com']);
  const { account, token } = link(sent?.text ?? '');
  expect(account).toBe('vera');
  expect(sent?.html).toContain(`token=${token}`);
  const state = () =>
    workspace(target, 'vera', { op: 'email_status', token_hash: '' }).catch(() => null);
  expect(await state()).toBeNull(); // a malformed digest is refused
  const status = async () =>
    workspace(target, 'vera', { op: 'email_status', token_hash: await sha(token) });
  expect(await status()).toEqual({ email: 'vera@example.com', verified: false, token_valid: true });
  // Opening the link (a GET, as a mail scanner would) verifies nothing.
  const opened = await call(target, `email/verify?account=vera&token=${token}`);
  expect(opened.status).toBe(404);
  expect((await status()).verified).toBe(false);
  // The page's confirm button POSTs it; once.
  expect((await call(target, 'email/verify', { account, token })).body).toEqual({ verified: true });
  expect(await status()).toEqual({ email: 'vera@example.com', verified: true, token_valid: false });
  const again = await call(target, 'email/verify', { account, token });
  expect(again.status).toBe(400);
  expect(again.body.error.code).toBe('INVALID_TOKEN');
  for (const bad of [{ account, token: 'x' }, { account: 'nobody', token }, {}]) {
    expect((await call(target, 'email/verify', bad)).status).toBe(400);
  }
});

it('shows the address and resends a link from Settings, at most five a day', async () => {
  const target = front();
  const cookie = await signup(target, 'rhea');
  expect((await call(target, 'email', undefined, cookie)).body).toEqual({
    email: 'rhea@example.com',
    verified: false,
  });
  expect((await call(target, 'email')).status).toBe(401);
  expect((await call(target, 'email/resend', {})).status).toBe(401);
  for (let i = 0; i < 5; i++)
    expect((await call(target, 'email/resend', {}, cookie)).body).toEqual({ sent: true });
  const limited = await call(target, 'email/resend', {}, cookie);
  expect(limited.status).toBe(429);
  const jobs = queued.filter((j) => j.kind === 'account_verify');
  expect(jobs).toHaveLength(5);
  const sent = await deliver(target, jobs[4]);
  expect(sent?.subject).toBe('Confirm your email for YonedaRepo');
  const { token } = link(sent?.text ?? '');
  await call(target, 'email/verify', { account: 'rhea', token });
  expect((await call(target, 'email', undefined, cookie)).body).toEqual({
    email: 'rhea@example.com',
    verified: true,
  });
  // Once verified, a queued older link is not sent.
  expect(await deliver(target, jobs[0])).toBeUndefined();
});

it('changes the address: verification cleared, a link to the new one, old links dead', async () => {
  const target = front();
  const cookie = await signup(target, 'otto');
  const welcome = link((await deliver(target, queued[0]))?.text ?? '').token;
  await call(target, 'email/verify', { account: 'otto', token: welcome });
  expect((await call(target, 'email', { email: 'not-an-address' }, cookie)).status).toBe(400);
  expect((await call(target, 'email', { email: 'Otto@Example.com' }, cookie)).status).toBe(409);
  expect((await call(target, 'email', { email: 'otto@new.example' })).status).toBe(401);
  expect((await call(target, 'email', { email: 'Otto@New.example' }, cookie)).body).toEqual({
    sent: true,
  });
  expect((await call(target, 'email', undefined, cookie)).body).toEqual({
    email: 'otto@new.example',
    verified: false,
  });
  const job = queued.at(-1) as Envelope;
  expect(job).toMatchObject({ kind: 'account_verify', workspace: 'otto' });
  // A second change before the first link is used: the first job sends nothing.
  await call(target, 'email', { email: 'otto@third.example' }, cookie);
  expect(await deliver(target, job)).toBeUndefined();
  const sent = await deliver(target, queued.at(-1) as Envelope);
  expect(sent?.to).toEqual(['otto@third.example']);
  const { token } = link(sent?.text ?? '');
  expect((await call(target, 'email/verify', { account: 'otto', token })).body).toEqual({
    verified: true,
  });
});

it('welcomes a provider-verified account without a link', async () => {
  const target = front();
  await workspace(target, 'octo', {
    op: 'identity_signup',
    username: 'octo',
    provider: 'github',
    subject: '7',
    login: 'octo',
    email: 'octo@example.com',
    session_hash: 'a'.repeat(64),
  });
  await (target.PLATFORM as unknown as PlatformEntrypoint).accountCreated('octo');
  expect(queued).toEqual([
    { v: 1, kind: 'account_welcome', repo_id: '', job_id: 'welcome', workspace: 'octo' },
  ]);
  const sent = await deliver(target, queued[0]);
  expect(sent?.to).toEqual(['octo@example.com']);
  expect(sent?.text).not.toContain('verify-email');
});
