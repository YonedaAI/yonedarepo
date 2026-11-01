// The Flight log sign-up (`/api/v1/newsletter`) through the real platform routes and D1 (workerd),
// with Resend stubbed: double opt-in, the answer that never says who is on the list, the limit
// per address, unsubscribing, the switch, the sweep of addresses nobody confirmed, and the
// operators' count and export. No real mail.
import { beforeEach, expect, it, vi } from 'vitest';
import migration from '../../cloudflare/migrations/0014_newsletter_subscribers.sql?raw';
import {
  NEWSLETTER_JOB,
  PENDING_MS,
  sweepNewsletter,
  unsubscribeToken,
} from '../../cloudflare/worker/platform-newsletter';
import { newsletterJob } from '../../cloudflare/worker/platform-newsletter-email';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env, Envelope } from '../../cloudflare/worker/types';
import { api, bindings, queued, scoped, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const DAY = 24 * 60 * 60 * 1000;
const OWNER = { token: 'local-test-owner' };
const on = {
  ...scoped,
  NEWSLETTER: 'on',
  NEWSLETTER_KEY: 'a test signing key',
  RESEND_API_KEY: { get: async () => 're_test_key' },
  EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.test>',
  EMAIL_CONTACT: 'hello@yonedarepo.test',
  WEB_ORIGIN: 'https://yonedarepo.test',
} as unknown as Env;
const off = { ...on, NEWSLETTER: 'off' } as unknown as Env;

beforeEach(async () => {
  for (const statement of migration.replace(/--.*$/gm, '').split(';'))
    if (statement.trim()) await bindings.INDEX.exec(statement.replace(/\s+/g, ' ').trim());
});

const rows = async () =>
  (await bindings.INDEX.prepare('SELECT * FROM newsletter_subscribers ORDER BY id').all<any>())
    .results;
const jobs = (): Envelope[] => queued.filter((m) => m.kind === NEWSLETTER_JOB);

async function post(path: string, body: unknown, target = on, headers: HeadersInit = {}) {
  const res = await platformFetch(
    new Request(`https://yoneda/api/v1/newsletter${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    target,
  );
  return { status: res.status, body: await res.json<any>() };
}
const signUp = (email: string, target = on) => post('', { email, consent: true }, target);

/** Runs a job against the stubbed Resend; returns what was posted, if anything. */
async function deliver(job: Envelope, target = on, answer = () => new Response('{}')) {
  const sent: any[] = [];
  const send = (async (_url: RequestInfo, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body)), headers: init?.headers });
    return answer();
  }) as typeof fetch;
  const outcome = await newsletterJob(target, job, 1, send);
  return { sent, outcome };
}
const lastJob = () => jobs().at(-1) as Envelope;

it('asks for a confirmation and emails a link that holds no address', async () => {
  const answer = await signUp('  Ada@Example.com ');
  expect(answer).toEqual({ status: 202, body: { accepted: true } });
  const [row] = await rows();
  expect(row).toMatchObject({ email: 'ada@example.com', confirmed_at: null, unsubscribed_at: null });
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

  const job = lastJob();
  expect(job.token).toMatch(/^[0-9a-f]{64}$/);
  expect(job.token).not.toBe(row.token_hash);
  expect(JSON.stringify(job)).not.toContain('ada@example.com');

  const { sent } = await deliver(job);
  expect(sent).toHaveLength(1);
  expect(sent[0].body.to).toEqual(['ada@example.com']);
  expect(sent[0].body.text).toContain(`https://yonedarepo.test/updates/confirm?token=${job.token}`);
  expect(sent[0].body.html).toContain(`/updates/confirm?token=${job.token}`);
});

it('puts an unsubscribe link and the one-click headers in every email', async () => {
  await signUp('ada@example.com');
  const { sent } = await deliver(lastJob());
  const [row] = await rows();
  const link = `https://yonedarepo.test/updates/unsubscribe?token=${await unsubscribeToken(on, row.id)}`;
  expect(sent[0].body.text).toContain(link);
  expect(sent[0].body.html).toContain(link);
  expect(sent[0].body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(sent[0].body.headers['List-Unsubscribe']).toContain('/api/v1/newsletter/unsubscribe?token=');
});

it('answers the same for a new, a pending, a confirmed and an unsubscribed address', async () => {
  await signUp('pending@example.com');
  await signUp('member@example.com');
  await post('/confirm', { token: lastJob().token });
  await signUp('gone@example.com');
  await post('/confirm', { token: lastJob().token });
  const [, , gone] = await rows();
  await post('/unsubscribe', { token: await unsubscribeToken(on, gone.id) });

  const answers = await Promise.all(
    ['new', 'pending', 'member', 'gone'].map((name) => signUp(`${name}@example.com`)),
  );
  for (const answer of answers) expect(answer).toEqual({ status: 202, body: { accepted: true } });
});

it('sends a subscriber who signs up again nothing, and keeps them subscribed', async () => {
  await signUp('member@example.com');
  await post('/confirm', { token: lastJob().token });
  const [before] = await rows();

  await signUp('member@example.com');
  expect((await deliver(lastJob())).sent).toEqual([]);
  expect((await rows())[0]).toEqual(before);
});

it('lets someone who unsubscribed come back, only by confirming again', async () => {
  await signUp('back@example.com');
  await post('/confirm', { token: lastJob().token });
  const [row] = await rows();
  await post('/unsubscribe', { token: await unsubscribeToken(on, row.id) });

  await signUp('back@example.com');
  const { sent } = await deliver(lastJob());
  expect(sent).toHaveLength(1);
  expect((await rows())[0].unsubscribed_at).not.toBeNull();

  await post('/confirm', { token: lastJob().token });
  expect((await rows())[0].unsubscribed_at).toBeNull();
});

it('refuses an invalid address or a missing consent, and stores neither', async () => {
  for (const email of ['', 'nobody', 'a@b', 'two@at@example.com', '=cmd@example.com', 7, null]) {
    const answer = await post('', { email, consent: true });
    expect(answer.status, String(email)).toBe(400);
    expect(answer.body.error.code).toBe('INVALID_EMAIL');
  }
  const unticked = await post('', { email: 'ada@example.com', consent: false });
  expect(unticked.body.error.code).toBe('CONSENT_REQUIRED');
  const bare = await post('', { email: 'ada@example.com' });
  expect(bare.body.error.code).toBe('CONSENT_REQUIRED');
  expect(await rows()).toEqual([]);
  expect(jobs()).toEqual([]);
});

it('refuses a body that is not JSON as an invalid address', async () => {
  const res = await platformFetch(
    new Request('https://yoneda/api/v1/newsletter', { method: 'POST', body: 'email=a' }),
    on,
  );
  expect(res.status).toBe(400);
});

it('refuses a form posted from another site', async () => {
  const answer = await post(
    '',
    { email: 'ada@example.com', consent: true },
    on,
    { origin: 'https://elsewhere.test' },
  );
  expect(answer.status).toBe(403);
  expect(await rows()).toEqual([]);
});

it('sends an address at most three confirmations a day, and answers the same past that', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(10 * DAY);
    const mailed: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      expect(await signUp('ada@example.com')).toEqual({ status: 202, body: { accepted: true } });
      mailed.push((await deliver(lastJob())).sent.length);
    }
    expect(mailed).toEqual([1, 1, 1, 0, 0]);
    vi.setSystemTime(11 * DAY + 1);
    await signUp('ada@example.com');
    expect((await deliver(lastJob())).sent).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('rate limits a client address and says so', async () => {
  const limited = {
    ...on,
    AUTH_LIMITER: { limit: async () => ({ success: false }) },
  } as unknown as Env;
  const answer = await signUp('ada@example.com', limited);
  expect(answer.status).toBe(429);
  expect(answer.body.error.code).toBe('RATE_LIMITED');
  expect(await rows()).toEqual([]);
});

it('confirms once, only with the live token', async () => {
  await signUp('ada@example.com');
  const { token } = lastJob();
  expect((await post('/confirm', { token: 'f'.repeat(64) })).status).toBe(400);
  expect((await post('/confirm', { token: 'short' })).status).toBe(400);
  expect((await rows())[0].confirmed_at).toBeNull();

  expect(await post('/confirm', { token })).toEqual({ status: 200, body: { confirmed: true } });
  const [row] = await rows();
  expect(row.confirmed_at).toEqual(expect.any(Number));
  expect(row.token_hash).toBeNull();

  const again = await post('/confirm', { token });
  expect(again.status).toBe(400);
  expect(again.body.error.code).toBe('INVALID_TOKEN');
});

it('refuses an expired confirmation', async () => {
  await signUp('ada@example.com');
  await bindings.INDEX.prepare('UPDATE newsletter_subscribers SET token_at=?')
    .bind(Date.now() - PENDING_MS - 1)
    .run();
  expect((await post('/confirm', { token: lastJob().token })).status).toBe(400);
  expect((await deliver(lastJob())).sent).toEqual([]);
});

it('does not confirm or unsubscribe on a GET, so a mail scanner opening a link changes nothing', async () => {
  await signUp('ada@example.com');
  const res = await platformFetch(
    new Request(`https://yoneda/api/v1/newsletter/confirm?token=${lastJob().token}`),
    on,
  );
  expect(res.status).toBe(404);
  expect((await rows())[0].confirmed_at).toBeNull();
});

it('unsubscribes with a signed token, more than once, and refuses a forged one', async () => {
  await signUp('ada@example.com');
  await post('/confirm', { token: lastJob().token });
  const [row] = await rows();
  const token = await unsubscribeToken(on, row.id);

  expect((await post('/unsubscribe', { token: `${row.id}.${'0'.repeat(64)}` })).status).toBe(400);
  expect((await post('/unsubscribe', { token: String(row.id) })).status).toBe(400);
  expect((await rows())[0].unsubscribed_at).toBeNull();

  expect(await post('/unsubscribe', { token })).toEqual({
    status: 200,
    body: { unsubscribed: true },
  });
  const first = (await rows())[0].unsubscribed_at;
  expect(first).toEqual(expect.any(Number));
  expect((await post('/unsubscribe', { token })).status).toBe(200);
  expect((await rows())[0].unsubscribed_at).toBe(first);
});

it('takes a mail client one-click unsubscribe (RFC 8058)', async () => {
  await signUp('ada@example.com');
  const [row] = await rows();
  const token = await unsubscribeToken(on, row.id);
  const res = await platformFetch(
    new Request(`https://yoneda/api/v1/newsletter/unsubscribe?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }),
    on,
  );
  expect(res.status).toBe(200);
  expect((await rows())[0].unsubscribed_at).toEqual(expect.any(Number));
});

it('says whether it is open: on only with the switch, the key and email configured', async () => {
  const open = async (target: Env) => {
    const res = await platformFetch(new Request('https://yoneda/api/v1/newsletter'), target);
    return (await res.json<any>()).open;
  };
  expect(await open(on)).toBe(true);
  expect(await open(off)).toBe(false);
  expect(await open({ ...scoped } as unknown as Env)).toBe(false);
  expect(await open({ ...on, NEWSLETTER_KEY: undefined } as unknown as Env)).toBe(false);
  expect(await open({ ...on, EMAIL_FROM: undefined } as unknown as Env)).toBe(false);
});

it('with the switch off, stores nothing and sends nothing', async () => {
  const answer = await signUp('ada@example.com', off);
  expect(answer.status).toBe(404);
  expect(await rows()).toEqual([]);
  expect(jobs()).toEqual([]);

  await signUp('bob@example.com');
  const job = lastJob();
  expect((await post('/confirm', { token: job.token }, off)).status).toBe(404);
  expect((await deliver(job, off)).sent).toEqual([]);
});

it('still honours an unsubscribe with the switch off', async () => {
  await signUp('ada@example.com');
  const [row] = await rows();
  const token = await unsubscribeToken(on, row.id);
  expect((await post('/unsubscribe', { token }, off)).status).toBe(200);
  expect((await rows())[0].unsubscribed_at).toEqual(expect.any(Number));
});

it('retries a Resend fault, and settles a permanent refusal', async () => {
  await signUp('ada@example.com');
  const job = lastJob();
  const fault = await deliver(job, on, () => new Response('{}', { status: 503 }));
  expect(fault.outcome.retry).toBeGreaterThan(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const refused = await deliver(job, on, () => new Response('{}', { status: 422 }));
  expect(refused.outcome).toEqual({});
});

it('routes the queue job', async () => {
  await signUp('ada@example.com');
  const message = {
    body: lastJob(),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<Envelope>;
  const noFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  await platformJob(on, message);
  expect(noFetch).toHaveBeenCalledOnce();
  expect(message.ack).toHaveBeenCalled();
});

it('sweeps addresses nobody confirmed, once a night, and leaves subscribers', async () => {
  await signUp('old@example.com');
  await signUp('member@example.com');
  await post('/confirm', { token: lastJob().token });
  await signUp('fresh@example.com');
  const at = Date.UTC(2026, 10, 2, 4, 30);
  await bindings.INDEX.prepare(
    "UPDATE newsletter_subscribers SET token_at=? WHERE email IN ('old@example.com','member@example.com')",
  )
    .bind(at - PENDING_MS - 1)
    .run();
  await bindings.INDEX.prepare("UPDATE newsletter_subscribers SET token_at=? WHERE email='fresh@example.com'")
    .bind(at - 1000)
    .run();

  await sweepNewsletter(on, at + 60_000);
  expect((await rows()).map((r) => r.email)).toHaveLength(3);
  await sweepNewsletter(on, at);
  expect((await rows()).map((r) => r.email)).toEqual(['member@example.com', 'fresh@example.com']);
});

it('counts confirmed subscribers on the overview, only with the switch on', async () => {
  await signUp('member@example.com');
  await post('/confirm', { token: lastJob().token });
  await signUp('pending@example.com');
  await signUp('gone@example.com');
  await post('/confirm', { token: lastJob().token });
  const gone = (await rows()).find((r) => r.email === 'gone@example.com');
  await post('/unsubscribe', { token: await unsubscribeToken(on, gone.id) });

  const overview = (target: Env) => api('/admin/overview', OWNER, {}, target);
  expect((await overview(on)).body.newsletter).toEqual({ confirmed: 1 });
  expect((await overview(off)).body.newsletter).toBeNull();
});

it('exports confirmed subscribers a page at a time, audited, to operators only', async () => {
  for (const name of ['a', 'b']) {
    await signUp(`${name}@example.com`);
    await post('/confirm', { token: lastJob().token });
  }
  await signUp('pending@example.com');

  const refused = await api('/admin/newsletter', {}, {}, on);
  expect(refused.status).toBe(401);

  const { status, body } = await api('/admin/newsletter', OWNER, {}, on);
  expect(status).toBe(200);
  expect(body.subscribers.map((s: any) => s.email)).toEqual(['a@example.com', 'b@example.com']);
  const [row] = await rows();
  expect(body.subscribers[0].unsubscribe_url).toBe(
    `https://yonedarepo.test/updates/unsubscribe?token=${await unsubscribeToken(on, row.id)}`,
  );
  expect(body.next).toBeNull();
  const audit = await bindings.INDEX.prepare(
    "SELECT action,target FROM admin_audit WHERE action='newsletter.export'",
  ).all<any>();
  expect(audit.results).toHaveLength(1);
  expect(JSON.stringify(audit.results)).not.toContain('@example.com');
});
