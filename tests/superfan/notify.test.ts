import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch } from '../../cloudflare/superfan/index';
import { DAILY_EMAIL_CAP, noticesOn, renderNotice } from '../../cloudflare/superfan/notify';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  analytics,
  deps,
  fakeUpstreams,
  feed,
  hour,
  RESEND_KEY,
  SCRIPT,
  testEnv,
} from './fake-platform';

const HOUR = 60 * 60_000;
const start = Date.parse('2026-10-20T15:07:00Z');
const OWNER = 'owner@yonedarepo.invalid';
afterEach(() => vi.restoreAllMocks());

const mailEnv = (overrides: Partial<SuperfanEnv> = {}) =>
  testEnv({
    ADMIN_NOTIFY_EMAIL: OWNER,
    EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
    RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
    ...overrides,
  });
const failing = { source_repository: { errors: 20 } };
const pass = async (e: SuperfanEnv, d: ReturnType<typeof deps>, now: number, bad = true) => {
  await feed(d.ledger, hour(now - 10 * 60_000, bad ? failing : {}), now);
  return runWatch(e, d);
};

describe('superfan notices', () => {
  it('mails a new finding once, however many passes still see it', async () => {
    const calls = fakeUpstreams(analytics());
    const e = mailEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(1);
    const [mail] = calls.mail;
    expect(mail.headers.get('authorization')).toBe(`Bearer ${RESEND_KEY}`);
    expect(mail.headers.get('idempotency-key')).toMatch(/^superfan\/[0-9a-f]{64}$/);
    expect(mail.body).toMatchObject({ to: [OWNER], from: e.EMAIL_FROM });
    expect(mail.body.subject).toBe(`[${SCRIPT}] 1 new finding`);
    expect(mail.body.text).toContain('SourceRepository errors at 10%');
    expect(mail.body.text).toContain('Group SourceRepository errors by status');
    // Exception samples stay out of the mail; the model's words and numbers go in.
    expect(mail.body.text).not.toContain('abc.def.ghi');
    for (const later of [1, 2]) {
      clock.now = start + later * HOUR;
      await pass(e, d, clock.now);
    }
    expect(calls.mail).toHaveLength(1);
    const [finding] = await d.ledger.findings('open', 10);
    expect(finding.notified_at).toBe(new Date(start).toISOString());
    expect(finding.occurrences).toBe(3);
  });

  it('keeps the finding for the next pass when the send fails', async () => {
    const calls = fakeUpstreams(analytics());
    const e = mailEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    calls.mailAnswer = () => new Response('{}', { status: 500 });
    await expect(pass(e, d, clock.now)).resolves.toMatchObject({ outcome: 'ok', anomalies: 1 });
    expect(log.mock.calls[0][0]).toContain('"status":500');
    expect((await d.ledger.findings('open', 10))[0].notified_at).toBeNull();
    expect((await d.ledger.status(clock.now)).spend.emails).toBe(0);
    calls.mailAnswer = () => Response.json({ id: 'fixture-email' });
    clock.now += HOUR;
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(2);
    expect((await d.ledger.findings('open', 10))[0].notified_at).not.toBeNull();
    expect((await d.ledger.status(clock.now)).spend.emails).toBe(1);
  });

  it('holds digests past the daily cap until the next UTC day', async () => {
    const calls = fakeUpstreams(analytics());
    const e = mailEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await d.ledger.observe(
      { key: 'seed:one', component: 'seed', kind: 'telemetry', signals: [], summary: 's' },
      clock.now,
    );
    for (let i = 0; i < DAILY_EMAIL_CAP; i++)
      expect(await d.ledger.claimNotice(clock.now, DAILY_EMAIL_CAP, 20)).toHaveLength(1);
    expect(await d.ledger.claimNotice(clock.now, DAILY_EMAIL_CAP, 20)).toEqual([]);
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(0);
    clock.now = Date.parse('2026-10-21T00:07:00Z');
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.subject).toBe(`[${SCRIPT}] 2 new findings`);
  });

  it('mails a reopened finding only when the last mail is older than the reopen window', async () => {
    const calls = fakeUpstreams(analytics());
    const e = mailEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(1);
    // Resolved, then back within the window: a flap, not news.
    clock.now += 2 * HOUR;
    await pass(e, d, clock.now, false);
    expect(await d.ledger.findings('open', 10)).toEqual([]);
    clock.now += HOUR;
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(1);
    // Resolved again and back with the first mail over six hours old.
    clock.now += HOUR;
    await pass(e, d, clock.now, false);
    clock.now += 3 * HOUR;
    await pass(e, d, clock.now);
    expect(calls.mail).toHaveLength(2);
  });

  it('still mails with the summary alone when the model cap is spent', async () => {
    const calls = fakeUpstreams(analytics());
    const e = mailEnv({ DAILY_CAP_MICROUSD: '0' });
    const d = deps(e, { now: start });
    await pass(e, d, start);
    expect(calls.model).toHaveLength(0);
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.text).toContain('error_rate=');
  });

  it('mails telemetry findings from a pass that had nothing to evaluate', async () => {
    const calls = fakeUpstreams(() => new Response('down', { status: 500 }));
    const e = mailEnv();
    const d = deps(e, { now: start });
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'telemetry_failed' });
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.text).toContain('telemetry');
  });

  it('is off without an address, a sender or the key, and counts nothing', async () => {
    const calls = fakeUpstreams(analytics());
    for (const missing of [
      { ADMIN_NOTIFY_EMAIL: '' },
      { EMAIL_FROM: undefined },
      { RESEND_API_KEY: undefined },
    ]) {
      const e = mailEnv(missing);
      expect(noticesOn(e)).toBe(false);
      const d = deps(e, { now: start });
      await pass(e, d, start);
      expect((await d.ledger.findings('open', 10))[0].notified_at).toBeNull();
      expect((await d.ledger.status(start)).spend.emails).toBe(0);
    }
    expect(calls.mail).toHaveLength(0);
  });

  it('never logs the key when the store cannot be read', async () => {
    const calls = fakeUpstreams(analytics());
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = mailEnv({
      RESEND_API_KEY: {
        get: () => Promise.reject(new Error(RESEND_KEY)),
      } as SecretsStoreSecret,
    });
    const d = deps(e, { now: start });
    await pass(e, d, start);
    expect(calls.mail).toHaveLength(0);
    expect(JSON.stringify(log.mock.calls)).not.toContain(RESEND_KEY);
    expect((await d.ledger.status(start)).spend.emails).toBe(0);
  });

  it('says on /status whether notices are on', async () => {
    fakeUpstreams(analytics());
    const status = (e: SuperfanEnv) =>
      superfanFetch(
        new Request('https://superfan.example/status', {
          headers: { authorization: 'Bearer fixture-read-token' },
        }),
        e,
      ).then((r) => r.json());
    expect(await status(mailEnv())).toMatchObject({ notices: 'email' });
    expect(await status(testEnv())).toMatchObject({ notices: 'off' });
  });

  it('renders a finding without a narrative from its summary', () => {
    const { subject, text } = renderNotice(SCRIPT, [
      {
        id: 3,
        component: 'telemetry',
        kind: 'telemetry',
        occurrences: 2,
        first_seen: '2026-10-20T15:07:00.000Z',
        summary: 'No tail events from the platform Worker this hour',
        narrative: null,
      } as never,
    ]);
    expect(subject).toBe(`[${SCRIPT}] 1 new finding`);
    expect(text).toContain('#3 telemetry (telemetry)');
    expect(text).toContain('No tail events');
  });
});
