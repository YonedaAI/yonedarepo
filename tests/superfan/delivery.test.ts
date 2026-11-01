// The queue delivery alert. The stall in these tests has the numbers of the real one on dev: no
// consumer for 70.7 s against 14.6 s at most normally, jobs waiting. Times and counts are invented
// around it, and nothing leaves the test: tail events, GraphQL and Resend are fakes.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperfanLedger } from '../../cloudflare/superfan/ledger';
import { deliveries, GAP_MS, type QueueMinutes, stallIn } from '../../cloudflare/superfan/delivery';
import { MIGRATIONS, migrate } from '../../cloudflare/superfan/ledger-schema';
import { runQuick } from '../../cloudflare/superfan/quick';
import { aggregate } from '../../cloudflare/superfan/tail';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  account,
  analytics,
  deps,
  FRONT_URL,
  fakeUpstreams,
  feed,
  hour,
  RESEND_KEY,
  SCRIPT,
  testEnv,
  traces,
} from './fake-platform';

const MINUTE = 60_000;
const JOBS = '44444444444444444444444444444444';
const QUEUE = `${SCRIPT}-jobs`;
const KEY = 'derived_jobs:delivery_gap';
/** On a minute boundary plus 30 s, so a 70.7 s gap holds no whole minute: the hard case. */
const stallFrom = Date.parse('2026-10-20T15:00:30Z');
const stallTo = stallFrom + 70_700;
const passAt = stallTo + 8 * MINUTE;

const invoked = (at: number, wallTime = 500, queue = QUEUE) =>
  ({
    ...traces({ component: 'derived_jobs', count: 1, wallMs: wallTime }, at)[0],
    event: { queue, batchSize: 1 },
    eventTimestamp: at,
  }) as unknown as TraceItem;
const minute = (at: number) => new Date(Math.floor(at / MINUTE) * MINUTE).toISOString();

type Row = [at: number, value: number];
/** The one account reply `CloudflareAnalytics.delivery` reads. */
const queueReply = (waiting: Row[], waited: Row[]) =>
  Response.json({
    data: {
      viewer: {
        accounts: [
          {
            waiting: waiting.map(([at, messages]) => ({
              avg: { messages },
              dimensions: { queueId: JOBS, datetimeMinute: minute(at) },
            })),
            waited: [
              ...waited.map(([at, lagTime]) => ({
                avg: { lagTime },
                dimensions: { queueId: JOBS, actionType: 'ReadMessage', datetimeMinute: minute(at) },
              })),
              // A delete counts no wait: only a read says how long a message sat.
              {
                avg: { lagTime: 999_000 },
                dimensions: {
                  queueId: JOBS,
                  actionType: 'DeleteMessage',
                  datetimeMinute: minute(stallTo),
                },
              },
            ],
          },
        ],
      },
    },
  });
/** Real shape for the hourly query; `reply` for the delivery one. */
const graphql = (reply: () => Response) => (init?: RequestInit) =>
  String(init?.body).includes('QueueDelivery')
    ? reply()
    : Response.json({ data: { viewer: { accounts: [account()] } }, errors: null });
const stalled = () => queueReply([[stallFrom + MINUTE, 3]], [[stallTo, 48_000]]);

const wide = () =>
  testEnv({
    WATCH_WIDE: 'on',
    WATCH_FRONT_URL: FRONT_URL,
    ADMIN_NOTIFY_EMAIL: 'owner@yonedarepo.invalid',
    EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
    RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
  });
type Deps = ReturnType<typeof deps>;
/** Quiet traffic, and the two invocations either side of a gap. */
async function gap(d: Deps, from = stallFrom, to = stallTo, now = passAt) {
  await feed(d.ledger, hour(now - 10 * MINUTE), now, true);
  await feed(d.ledger, [invoked(from - 500, 500), invoked(to)], now, true);
}
const keys = async (d: Deps) => (await d.ledger.findings('open', 30)).map((f) => f.dedup_key);
const found = async (d: Deps) => {
  const row = (await d.ledger.findings('open', 30)).find((f) => f.dedup_key === KEY);
  if (!row) throw new Error(`No ${KEY}: ${await keys(d)}`);
  return row;
};
afterEach(() => vi.restoreAllMocks());

describe('catching a stall', () => {
  it('files one urgent finding naming the queue, the gap and the evidence, and mails it', async () => {
    const calls = fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    await gap(d);
    await runQuick(e, d);
    const row = await found(d);
    expect(row).toMatchObject({ level: 'urgent', component: 'derived_jobs' });
    expect(row.summary).toContain('delivery_gap=70.7');
    expect(row.summary).toContain(QUEUE);
    const [mail] = calls.mail;
    expect(mail.body.subject).toBe('[URGENT dev] Jobs queue had no consumer for 70.7 s');
    expect(mail.body.text).toContain(QUEUE);
    expect(mail.body.text).toContain('3 waiting');
    expect(mail.body.text).toContain('48.0 s');
  });

  it('is a digest off the wide watch, from the hourly pass', async () => {
    fakeUpstreams(graphql(stalled));
    const e = testEnv();
    const d = deps(e, { now: passAt });
    await gap(d);
    await runWatch(e, d);
    expect(await found(d)).toMatchObject({ level: 'digest' });
  });

  it('sees the gap across tail batches', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    await feed(d.ledger, [invoked(stallFrom - 500)], stallFrom, true);
    await feed(d.ledger, [invoked(stallTo)], passAt, true);
    await runQuick(e, d);
    expect(await keys(d)).toContain(KEY);
  });

  it('keeps the worst gap of several', () => {
    const minutes: QueueMinutes = {
      waiting: { [Date.parse(minute(stallFrom + MINUTE))]: 3 },
      waited: { [Date.parse(minute(stallTo))]: 48_000 },
    };
    const short = { queue: QUEUE, from: stallFrom, to: stallFrom + GAP_MS + 1 };
    const long = { queue: QUEUE, from: stallFrom, to: stallTo };
    expect(stallIn([short, long], minutes)).toMatchObject({ gapMs: 70_700 });
  });
});

describe('staying quiet', () => {
  it('stays quiet for an empty queue, however long the gap', async () => {
    fakeUpstreams(graphql(() => queueReply([], [])));
    const e = wide();
    const d = deps(e, { now: passAt });
    await gap(d, stallFrom - 30 * MINUTE, stallTo);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('stays quiet for a burst after an idle spell: a backlog, and nobody waited', async () => {
    fakeUpstreams(graphql(() => queueReply([[stallTo, 40]], [[stallTo, 900]])));
    const e = wide();
    const d = deps(e, { now: passAt });
    await gap(d);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('stays quiet at 60 s and under, and at the normal 14.6 s', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    await gap(d, stallFrom, stallFrom + 14_600);
    await gap(d, stallFrom + 14_600, stallFrom + 14_600 + GAP_MS);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('is not fooled by a long job: the consumer was running', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    await feed(d.ledger, [invoked(stallFrom, 65_000), invoked(stallTo)], passAt, true);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('reads tail events in time order, and a late one cannot make a gap', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    await feed(d.ledger, [invoked(stallTo), invoked(stallFrom - 500)], passAt, true);
    await runQuick(e, d);
    expect(await keys(d)).toContain(KEY);
    const late = deps(e, { now: passAt });
    await feed(late.ledger, [invoked(stallTo)], passAt, true);
    await feed(late.ledger, [invoked(stallFrom)], passAt, true);
    await runQuick(e, late);
    expect(await keys(late)).toEqual([]);
  });

  it('watches the jobs queue alone', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const d = deps(e, { now: passAt });
    const checks = `${SCRIPT}-checks`;
    await feed(d.ledger, [invoked(stallFrom, 500, checks), invoked(stallTo, 500, checks)], passAt, true);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('reads only consumer invocations of the platform', () => {
    const elsewhere = { ...invoked(stallTo), scriptName: 'yonedarepo-dev-agents' } as TraceItem;
    const api = traces({ component: 'api_worker', count: 1, wallMs: 5 }, stallTo);
    expect(deliveries([elsewhere, ...api], SCRIPT)).toEqual([]);
    expect(aggregate([invoked(stallTo)], SCRIPT)).toHaveLength(1);
    expect(deliveries([invoked(stallTo, 700)], SCRIPT)).toEqual([
      { queue: QUEUE, start: stallTo, end: stallTo + 700 },
    ]);
  });

  it('asks GraphQL nothing more with no gap', async () => {
    const calls = fakeUpstreams(graphql(stalled));
    const e = testEnv();
    const d = deps(e, { now: passAt });
    await feed(d.ledger, hour(passAt - 10 * MINUTE), passAt);
    await runWatch(e, d);
    expect(calls.graphql).toHaveLength(1);
  });
});

describe('after a stall', () => {
  it('ends once the gap is past the window', async () => {
    fakeUpstreams(graphql(stalled));
    const e = wide();
    const clock = { now: passAt };
    const d = deps(e, clock);
    await gap(d);
    await runQuick(e, d);
    expect(await keys(d)).toContain(KEY);
    clock.now = passAt + 2 * 60 * MINUTE;
    await feed(d.ledger, hour(clock.now - 10 * MINUTE), clock.now, true);
    await runQuick(e, d);
    expect(await keys(d)).not.toContain(KEY);
  });

  it('waits for analytics that have not arrived, and fires when they do', async () => {
    let reply = () => queueReply([], []);
    fakeUpstreams(graphql(() => reply()));
    const e = wide();
    const clock = { now: stallTo + MINUTE };
    const d = deps(e, clock);
    await gap(d, stallFrom, stallTo, clock.now);
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
    reply = stalled;
    clock.now = passAt;
    await runQuick(e, d);
    expect(await keys(d)).toContain(KEY);
  });

  it('calls a failed read blind on the hourly pass, never quiet', async () => {
    fakeUpstreams(graphql(() => new Response('no', { status: 500 })));
    const e = testEnv();
    const d = deps(e, { now: passAt });
    await gap(d);
    await runWatch(e, d);
    expect(await keys(d)).toEqual(['telemetry:fetch_failed']);
  });

  it('keeps a stall open through a failed read on the quick pass', async () => {
    let reply = stalled;
    fakeUpstreams(graphql(() => reply()));
    const e = wide();
    const clock = { now: passAt };
    const d = deps(e, clock);
    await gap(d);
    await runQuick(e, d);
    reply = () => new Response('no', { status: 500 });
    clock.now += 5 * MINUTE;
    await runQuick(e, d);
    expect(await keys(d)).toContain(KEY);
  });

  it('keeps the table bounded', async () => {
    fakeUpstreams(analytics());
    const d = deps(testEnv(), { now: passAt });
    const late = passAt + 24 * 60 * MINUTE;
    await feed(d.ledger, [invoked(stallFrom), invoked(stallTo)], passAt);
    await feed(d.ledger, [invoked(late)], late);
    expect(await d.ledger.queueGaps(0)).toHaveLength(1);
    expect((await d.ledger.queueGaps(0))[0].from).toBeGreaterThan(stallTo);
  });
});

describe('ledger schema', () => {
  it('upgrades a ledger at version 6 and repeats safely', async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName('schema-upgrade-7')) as DurableObjectStub<SuperfanLedger>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE queue_gaps');
      sql.exec('DROP TABLE queue_consumers');
      sql.exec('UPDATE schema_version SET version = 6');
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(migrate(sql)).toBe(MIGRATIONS.length);
      expect(sql.exec('SELECT COUNT(*) AS n FROM queue_gaps').one().n).toBe(0);
    });
  });
});
