// The dead-man: a separate Worker that says so when Superfan stops. Superfan's heartbeat is real
// where a test says so; Resend is always a fake.
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import deadman, {
  CONFIRM_CHECKS,
  type DeadmanEnv,
  FULL_MAX_MS,
  QUICK_MAX_MS,
  REPEAT_MS,
  runDeadman,
} from '../../cloudflare/superfan/deadman';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch } from '../../cloudflare/superfan/index';
import { runQuick } from '../../cloudflare/superfan/quick';
import { analytics, deps, FRONT_URL, fakeUpstreams, RESEND_KEY, SUPERFAN_URL, testEnv } from './fake-platform';

const start = Date.parse('2026-10-20T15:05:00Z');
const FIVE = 5 * 60_000;
const OWNER = 'owner@yonedarepo.invalid';
afterEach(() => vi.restoreAllMocks());

type StateNamespace = DeadmanEnv['STATE'];
/** The real Durable Object class, one fresh instance per test. */
const freshState = () => {
  const { STATE } = env as unknown as { STATE: StateNamespace };
  const id = STATE.newUniqueId();
  return { idFromName: () => id, get: (i: DurableObjectId) => STATE.get(i) } as unknown as StateNamespace;
};
const deadmanEnv = (overrides: Partial<DeadmanEnv> = {}): DeadmanEnv =>
  ({
    STATE: freshState(),
    SUPERFAN_URL,
    ADMIN_NOTIFY_EMAIL: OWNER,
    EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
    RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
    ...overrides,
  }) as DeadmanEnv;
const beat = (fields: Record<string, unknown>) => () =>
  Response.json({ full_at: start, quick_at: start, notices: true, ...fields });
const heartbeat = `${SUPERFAN_URL}/heartbeat`;

describe('dead-man check', () => {
  it('says nothing while Superfan beats', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = beat({});
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS + 2; i++) await runDeadman(e, start + i * 1000);
    expect(calls.mail).toHaveLength(0);
  });

  it('alerts when Superfan stops answering, only after repeated checks', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = () => new Response('gone', { status: 404 });
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS - 1; i++) await runDeadman(e, start + i * FIVE);
    expect(calls.mail).toHaveLength(0);
    await runDeadman(e, start + CONFIRM_CHECKS * FIVE);
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body).toMatchObject({ to: [OWNER] });
    expect(calls.mail[0].body.subject).toContain('URGENT');
    expect(calls.mail[0].body.text).toContain('HTTP 404');
    expect(calls.mail[0].body.text).toContain('docs/incidents.md');
    expect(calls.mail[0].headers.get('authorization')).toBe(`Bearer ${RESEND_KEY}`);
  });

  it.each([
    ['the five-minute cron', { quick_at: start - QUICK_MAX_MS - 1 }, 'five-minute'],
    ['the hourly cron', { full_at: start - FULL_MAX_MS - 1 }, 'hourly'],
    ['mail', { notices: false }, 'cannot mail'],
    ['a garbled answer', { full_at: 'soon' }, 'unreadable'],
  ])('alerts on a stale %s', async (_name, fields, words) => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = beat(fields);
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS; i++) await runDeadman(e, start);
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.text).toContain(words);
  });

  it('accepts a Superfan with no quick pass yet, so a hourly-only env does not alert', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = beat({ quick_at: null });
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS + 1; i++) await runDeadman(e, start);
    expect(calls.mail).toHaveLength(0);
  });

  it('a fresh Superfan that has run only quick passes is alive', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = beat({ full_at: null });
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS + 1; i++) await runDeadman(e, start);
    expect(calls.mail).toHaveLength(0);
  });

  it('a blip clears the count', async () => {
    const calls = fakeUpstreams(analytics());
    const e = deadmanEnv();
    for (let round = 0; round < 3; round++) {
      calls.routes[heartbeat] = () => new Response('', { status: 503 });
      for (let i = 0; i < CONFIRM_CHECKS - 1; i++) await runDeadman(e, start);
      calls.routes[heartbeat] = beat({});
      await runDeadman(e, start);
    }
    expect(calls.mail).toHaveLength(0);
  });

  it('repeats at most once per repeat window while Superfan stays down', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = () => new Response('', { status: 503 });
    const e = deadmanEnv();
    const day = (24 * 60 * 60_000) / FIVE;
    for (let i = 0; i < day; i++) await runDeadman(e, start + i * FIVE);
    expect(calls.mail).toHaveLength(Math.ceil((24 * 60 * 60_000) / REPEAT_MS));
  });

  it('retries a failed send on the next check, keeping its idempotency key', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = () => new Response('', { status: 503 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    calls.mailAnswer = () => new Response('{}', { status: 500 });
    const e = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS; i++) await runDeadman(e, start);
    expect(calls.mail).toHaveLength(1);
    calls.mailAnswer = () => Response.json({ id: 'fixture-email' });
    await runDeadman(e, start + FIVE);
    expect(calls.mail).toHaveLength(2);
    expect(calls.mail[1].headers.get('idempotency-key')).toBe(
      calls.mail[0].headers.get('idempotency-key'),
    );
    await runDeadman(e, start + 2 * FIVE);
    expect(calls.mail).toHaveLength(2);
  });

  it('never logs the mail key', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = () => new Response('', { status: 503 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = deadmanEnv({
      RESEND_API_KEY: { get: () => Promise.reject(new Error(RESEND_KEY)) } as SecretsStoreSecret,
    });
    for (let i = 0; i < CONFIRM_CHECKS; i++) await runDeadman(e, start);
    expect(calls.mail).toHaveLength(0);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(RESEND_KEY);
  });

  it('reports its own last check on /health, which Superfan reads', async () => {
    const calls = fakeUpstreams(analytics());
    calls.routes[heartbeat] = beat({});
    const e = deadmanEnv();
    await runDeadman(e, start);
    const health = await deadman.fetch(new Request('https://deadman.example/health'), e);
    expect(await health.json()).toEqual({ service: 'yonedarepo-deadman', last_check_at: start });
    expect((await deadman.fetch(new Request('https://deadman.example/x'), e)).status).toBe(404);
  });
});

describe('Superfan heartbeat', () => {
  const superfanEnv = (overrides: Partial<SuperfanEnv> = {}) =>
    testEnv({
      WATCH_WIDE: 'on',
      WATCH_FRONT_URL: FRONT_URL,
      ADMIN_NOTIFY_EMAIL: OWNER,
      EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
      RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
      ...overrides,
    });

  it('needs no bearer and says only when passes ran and whether it can mail', async () => {
    fakeUpstreams(analytics());
    const e = superfanEnv();
    const res = await superfanFetch(new Request('https://superfan.example/heartbeat'), e);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['full_at', 'notices', 'quick_at']);
    expect(body.notices).toBe(true);
  });

  it('a quick pass beats, and the dead-man reads that beat through the real route', async () => {
    const calls = fakeUpstreams(analytics());
    const e = superfanEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await runQuick(e, d);
    const beats = await d.ledger.beats();
    expect(beats.quick_at).toBe(start);
    calls.routes[heartbeat] = () => Response.json({ ...beats, notices: true });
    const dead = deadmanEnv();
    for (let i = 0; i < CONFIRM_CHECKS; i++) await runDeadman(dead, start + 60_000);
    expect(calls.mail).toHaveLength(0);
    for (let i = 0; i < CONFIRM_CHECKS; i++) await runDeadman(dead, start + QUICK_MAX_MS + 60_000);
    expect(calls.mail).toHaveLength(1);
  });
});
