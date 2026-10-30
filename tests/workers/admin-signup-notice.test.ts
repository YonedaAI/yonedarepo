// The operators' sign-up notice (workerd, Resend stubbed): one email per job's sign-up,
// none for a redelivery or a sign-up an earlier email named, at most one per five minutes
// with later sign-ups rolled into the next ("+N more"), retry on Resend's transient
// answers, and nothing at all while email is unconfigured. No real Resend calls.
import { expect, it } from 'vitest';
import { recordAccount } from '../../cloudflare/worker/account-index';
import { NOTICE_WINDOW_MS, signupNoticeJob } from '../../cloudflare/worker/platform-signup-notice';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { bindings, delayed, scoped, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const configured = {
  ...scoped,
  RESEND_API_KEY: { get: async () => 're_test_key' },
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  EMAIL_CONTACT: 'hello@yonedarepo.test',
  ADMIN_NOTIFY_EMAIL: 'ops@yonedarepo.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
} as unknown as Env;
const job = (account: string): Envelope => ({
  v: 1,
  kind: 'admin_signup_notice',
  repo_id: '',
  job_id: account,
  workspace: account,
});
function resend(answers: number[] = []) {
  const got: { headers: Headers; json: any }[] = [];
  const send = (async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    got.push({ headers: req.headers, json: await req.json() });
    const status = answers.shift() ?? 200;
    return Response.json(status === 200 ? { id: 'email-1' } : { name: 'application_error' }, { status });
  }) as typeof fetch;
  return { got, send };
}

it('emails the operators once per sign-up, with a link to the account', async () => {
  const now = Date.now();
  await recordAccount(bindings, 'ada', 'github', now - 1000);
  const { got, send } = resend();
  expect(await signupNoticeJob(configured, job('ada'), 1, send, now)).toEqual({});
  expect(got).toHaveLength(1);
  expect(got[0].json).toMatchObject({ to: ['ops@yonedarepo.test'], subject: 'New sign-up: ada' });
  expect(got[0].json.text).toContain('ada, via GitHub');
  expect(got[0].json.text).toContain('https://yonedarepo.test/admin/users/ada');
  expect(got[0].headers.get('idempotency-key')).toMatch(/^admin-signup\/[0-9a-f]{64}$/);
  // A redelivery after the email was recorded sends nothing.
  await signupNoticeJob(configured, job('ada'), 2, send, now + 1000);
  expect(got).toHaveLength(1);
});

it('sends at most one email per five minutes and rolls later sign-ups into the next', async () => {
  const now = Date.now();
  await recordAccount(bindings, 'first', 'email', now - 1000);
  const { got, send } = resend();
  await signupNoticeJob(configured, job('first'), 1, send, now);
  for (const name of ['second', 'third']) await recordAccount(bindings, name, 'google', now + 1000);
  delayed.length = 0;
  await signupNoticeJob(configured, job('second'), 1, send, now + 2000);
  await signupNoticeJob(configured, job('third'), 1, send, now + 2000);
  expect(got).toHaveLength(1);
  expect(delayed.map((j) => j.workspace)).toEqual(['second', 'third']);
  // After the window, the first redelivered job names both; the other then sends nothing.
  const later = now + NOTICE_WINDOW_MS + 1;
  await signupNoticeJob(configured, job('second'), 1, send, later);
  await signupNoticeJob(configured, job('third'), 1, send, later);
  expect(got).toHaveLength(2);
  expect(got[1].json.subject).toMatch(/^New sign-up: (second|third) \+1 more$/);
  expect(got[1].json.text).toContain('+1 more:');
});

it('retries transient failures, repeating the idempotency key, and stays off unconfigured', async () => {
  const now = Date.now();
  await recordAccount(bindings, 'grace', 'email', now - 1000);
  const { got, send } = resend([503]);
  expect(await signupNoticeJob(configured, job('grace'), 1, send, now)).toEqual({ retry: 30 });
  expect(await signupNoticeJob(configured, job('grace'), 2, send, now + 30_000)).toEqual({});
  expect(got).toHaveLength(2);
  expect(got[1].headers.get('idempotency-key')).toBe(got[0].headers.get('idempotency-key'));
  // No Resend key: off, nothing sent. No ADMIN_NOTIFY_EMAIL: EMAIL_CONTACT.
  await recordAccount(bindings, 'hopper', 'email', now + 40_000);
  const off = resend();
  await signupNoticeJob({ ...configured, RESEND_API_KEY: undefined } as Env, job('hopper'), 1, off.send, now + NOTICE_WINDOW_MS * 2);
  expect(off.got).toHaveLength(0);
  await signupNoticeJob({ ...configured, ADMIN_NOTIFY_EMAIL: undefined } as Env, job('hopper'), 1, off.send, now + NOTICE_WINDOW_MS * 2);
  expect(off.got[0].json.to).toEqual(['hello@yonedarepo.test']);
});
