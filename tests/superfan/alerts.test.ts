// The wide watch and the two alert levels. Numbers and failures are invented; nothing leaves the
// test: telemetry, health, the model and Resend are all fakes (fake-platform.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import devSpec from '../../infra/envs/dev.json?raw';
import type { SuperfanEnv } from '../../cloudflare/superfan/config';
import { superfanFetch, superfanTail } from '../../cloudflare/superfan/index';
import { DAILY_EMAIL_CAP } from '../../cloudflare/superfan/notify';
import { URGENT_GAP_MS, URGENT_PER_DAY } from '../../cloudflare/superfan/ledger-notice';
import { QUICK_CRON, runQuick } from '../../cloudflare/superfan/quick';
import { aggregate, redact } from '../../cloudflare/superfan/tail';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  analytics,
  DEADMAN_URL,
  deps,
  FRONT_SCRIPT,
  FRONT_URL,
  fakeUpstreams,
  feed,
  hour,
  logLine,
  MANAGED_SCRIPT,
  NO_IDS,
  RESEND_KEY,
  SCRIPT,
  testEnv,
  traces,
} from './fake-platform';

const HOUR = 60 * 60_000;
const start = Date.parse('2026-10-20T15:07:00Z');
const recent = (now: number) => now - 10 * 60_000;
const OWNER = 'owner@yonedarepo.invalid';
afterEach(() => vi.restoreAllMocks());

const wideEnv = (overrides: Partial<SuperfanEnv> = {}) =>
  testEnv({
    WATCH_WIDE: 'on',
    WATCH_FRONT_URL: FRONT_URL,
    ADMIN_NOTIFY_EMAIL: OWNER,
    EMAIL_FROM: 'YonedaRepo <hello@yonedarepo.invalid>',
    RESEND_API_KEY: { get: async () => RESEND_KEY } as SecretsStoreSecret,
    ...overrides,
  });
const down = () => new Response('down', { status: 503 });
const urgentMail = (m: { body: Record<string, any> }) =>
  m.body.text.startsWith('Needs attention now');
const quiet = async (d: ReturnType<typeof deps>, now: number) =>
  feed(
    d.ledger,
    [...hour(recent(now)), ...traces({ component: 'cron', count: 60, wallMs: 40 }, recent(now))],
    now,
    true,
  );
/** A quiet hour plus one log line, delivered by `component`'s invocation. */
const logged = async (
  d: ReturnType<typeof deps>,
  now: number,
  log: ReturnType<typeof logLine>,
  component: Parameters<typeof traces>[0]['component'] = 'derived_jobs',
  script?: string,
) => {
  await quiet(d, now);
  await feed(
    d.ledger,
    traces({ component, count: 1, wallMs: 60, logs: [log], script }, recent(now)),
    now,
    true,
  );
};
const keys = async (d: ReturnType<typeof deps>) =>
  (await d.ledger.findings('open', 50)).map((f) => f.dedup_key).sort();
const finding = async (d: ReturnType<typeof deps>, key: string) => {
  const found = (await d.ledger.findings('open', 50)).find((f) => f.dedup_key === key);
  if (!found) throw new Error(`No open finding ${key}: ${await keys(d)}`);
  return found;
};

describe('blind spots', () => {
  it('classifies crons and all eight Durable Object classes', () => {
    const rows = aggregate(
      [
        ...traces({ component: 'cron', count: 2, wallMs: 40 }, start),
        ...traces({ component: 'land_queue', count: 1, wallMs: 40 }, start),
        ...traces({ component: 'commit_shards', count: 1, wallMs: 40 }, start),
        ...traces({ component: 'pack_builder', count: 1, wallMs: 40 }, start),
        ...traces({ component: 'ssh_gateway', count: 1, wallMs: 40 }, start),
        ...traces({ component: 'workspace_authority', count: 1, wallMs: 40 }, start),
      ],
      SCRIPT,
      true,
    );
    expect(Object.fromEntries(rows.map((r) => [r.component, r.invocations]))).toEqual({
      cron: 2,
      land_queue: 1,
      commit_shards: 1,
      pack_builder: 1,
      ssh_gateway: 1,
      workspace_authority: 1,
    });
  });

  it('reads the front and managed Workers only on the wide watch', () => {
    const events = [
      ...traces({ component: 'front_worker', count: 2, wallMs: 40, script: FRONT_SCRIPT }, start),
      ...traces(
        { component: 'managed_worker', count: 3, wallMs: 40, script: MANAGED_SCRIPT },
        start,
      ),
      ...traces(
        { component: 'managed_worker', count: 1, wallMs: 40, script: 'yonedarepo-dev-bench' },
        start,
      ),
    ];
    expect(aggregate(events, SCRIPT, false)).toEqual([]);
    expect(
      Object.fromEntries(aggregate(events, SCRIPT, true).map((r) => [r.component, r.invocations])),
    ).toEqual({ front_worker: 2, managed_worker: 3 });
  });

  it('the tail handler takes the sibling Workers once the switch is on', async () => {
    fakeUpstreams(analytics());
    const front = traces(
      { component: 'front_worker', count: 25, wallMs: 40, errors: 5, script: FRONT_SCRIPT },
      Date.now() - 60_000,
    );
    const e = wideEnv();
    await superfanTail(front, e);
    const status = await superfanFetch(
      new Request('https://superfan.example/status', {
        headers: { authorization: 'Bearer fixture-read-token' },
      }),
      e,
    );
    expect((await status.json()).tail_events_last_hour).toBeGreaterThanOrEqual(25);
  });

  it('watches the front and managed Workers, by their own error rates', async () => {
    fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    const bad = { count: 25, wallMs: 40, errors: 5 };
    await feed(
      d.ledger,
      [
        ...traces({ component: 'front_worker', ...bad, script: FRONT_SCRIPT }, recent(start)),
        ...traces({ component: 'managed_worker', ...bad, script: MANAGED_SCRIPT }, recent(start)),
      ],
      start,
      true,
    );
    await runWatch(e, d);
    expect(await keys(d)).toEqual([
      'front_worker:error_rate+exceptions',
      'managed_worker:error_rate+exceptions',
    ]);
  });

  it('watches each newly seen Durable Object class by name', async () => {
    fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    for (const component of [
      'commit_shards',
      'workspace_authority',
      'pack_builder',
      'ssh_gateway',
      'land_queue',
    ] as const)
      await feed(
        d.ledger,
        traces({ component, count: 25, wallMs: 40, errors: 5 }, recent(start)),
        start,
        true,
      );
    await runWatch(e, d);
    expect(await keys(d)).toEqual([
      'commit_shards:error_rate+exceptions',
      'land_queue:error_rate+exceptions',
      'pack_builder:error_rate+exceptions',
      'ssh_gateway:error_rate+exceptions',
      'workspace_authority:error_rate+exceptions',
    ]);
  });

  it('counts failed and timed out landings on the land queue', async () => {
    fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    const lines = [
      ...Array(2).fill(logLine('land.batch_failed', 'warn')),
      ...Array(2).fill(logLine('land.submitted_batch_failed', 'warn')),
      ...Array(2).fill(logLine('land.step_failed', 'warn')),
      ...Array(11).fill(logLine('land.timed_out', 'warn')),
    ];
    await feed(
      d.ledger,
      traces({ component: 'land_queue', count: 1, wallMs: 40, logs: lines }, recent(start)),
      start,
      true,
    );
    await runWatch(e, d);
    const f = await finding(d, 'land_queue:land_failures+land_timeouts');
    expect(f.summary).toContain('land_failures=6');
    expect(f.summary).toContain('land_timeouts=11');
  });

  it('reads the checks backlog', async () => {
    fakeUpstreams(analytics({ checksBacklog: [5, 400] }));
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    await runWatch(e, d);
    expect(await keys(d)).toEqual(['check_runs:backlog+backlog_growth']);
  });

  it('asks Cloudflare for every queue once the switch is on, by name', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv(NO_IDS);
    const d = deps(e, { now: start });
    await quiet(d, start);
    await runWatch(e, d);
    const { variables } = JSON.parse(String(calls.graphql[0].body));
    expect(variables.queues).toEqual([
      '44444444444444444444444444444444',
      '55555555555555555555555555555555',
      '77777777777777777777777777777777',
      '88888888888888888888888888888888',
      '99999999999999999999999999999999',
    ]);
  });

  it('holds a stall a burst of exceptions would have pushed out of the samples', async () => {
    fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start)), start);
    await feed(
      d.ledger,
      traces(
        {
          component: 'derived_jobs',
          count: 1,
          wallMs: 60,
          logs: [logLine('compaction.stalled', 'error', { repo: 'r0' })],
        },
        recent(start),
      ),
      start,
    );
    await feed(
      d.ledger,
      traces({ component: 'derived_jobs', count: 3, wallMs: 60, errors: 3 }, recent(start) + 60_000),
      start,
    );
    await runWatch(e, d);
    const [f] = (await d.ledger.findings('open', 10)).filter((x) =>
      x.dedup_key.includes('compaction_stalls'),
    );
    expect(f?.summary).toContain('compaction_stalls=1');
  });
});

describe('log lines before and after the shared logger', () => {
  /** A line as cloudflare/worker/log.ts writes it: one JSON string, `event` first, its own
   * `level` a word, then the request's fields. */
  const logger = (event: string, level: string, fields: Record<string, unknown> = {}) => ({
    level: level === 'info' ? 'log' : level,
    message: [JSON.stringify({ event, level, request_id: 'req-1', repo: 'r0', ...fields })],
  });
  const counted = (line: ReturnType<typeof logLine>) =>
    aggregate(
      traces({ component: 'derived_jobs', count: 1, wallMs: 40, logs: [line] }, start),
      SCRIPT,
      true,
    )[0].marks;

  it.each([
    ['the old text', { level: 'warn', message: ['object store push attempt 2 refused: busy'] }],
    ['the logger JSON', logger('object.push_retry', 'warn', { attempt: 2, reason: 'busy' })],
  ])('counts a push retry from %s', (_form, line) => {
    const rows = aggregate(
      traces({ component: 'api_worker', count: 3, wallMs: 40, logs: [line] }, start),
      SCRIPT,
    );
    expect(rows.find((r) => r.component === 'object_push_queue')?.pushRetries).toBe(3);
  });

  it.each([
    ['billing.reconcile.mismatch', 'error', 'reconcile_mismatches'],
    ['compaction.stalled', 'error', 'compaction_stalls'],
    ['undo.sweep_failed', 'error', 'cron_failures'],
    ['compaction.sweep_failed', 'error', 'cron_failures'],
    ['billing.reconcile_failed', 'error', 'cron_failures'],
    ['billing.reconcile', 'error', 'cron_failures'],
    ['ssh.keepalive_failed', 'error', 'cron_failures'],
    ['land.batch_failed', 'warn', 'land_failures'],
    ['land.submitted_batch_failed', 'warn', 'land_failures'],
    ['land.step_failed', 'warn', 'land_failures'],
    ['land.timed_out', 'warn', 'land_timeouts'],
  ])('counts %s from the logger JSON', (event, level, mark) => {
    expect(counted(logger(event, level))).toEqual({ [mark]: 1 });
  });

  it('reads storage from db_bytes, as the logger has a level of its own', () => {
    const line = logger('repo.storage', 'info', { threshold: 9e9, db_bytes: 9.1e9 });
    expect(counted(line)).toEqual({ storage_9gb: 1 });
  });

  it('reads a repository at the limit from its size, or from a refusal', () => {
    const line = logger('repo.storage', 'info', { threshold: 9.4e9, db_bytes: 9.4e9 });
    expect(counted(line)).toEqual({ storage_full: 1 });
    expect(counted(logger('repo.storage', 'info', { db_bytes: 9.3e9 }))).toEqual({ storage_9gb: 1 });
    expect(counted(logger('repo.full', 'warn', { repo: 'r0', op: 'repo_land' }))).toEqual({ storage_full: 1 });
  });

  it('counts a line logged as an object, and ignores one that only mentions an event', () => {
    const object = { level: 'error', message: [{ event: 'billing.reconcile.mismatch' }] };
    expect(counted(object as never)).toEqual({ reconcile_mismatches: 1 });
    const prose = { level: 'error', message: ['saw billing.reconcile.mismatch in a report'] };
    expect(counted(prose)).toEqual({});
  });
});

describe('a deploy', () => {
  it('does not count the restart of its own Durable Objects as a fault', () => {
    const event = (message: string) =>
      ({
        scriptName: 'yonedarepo-dev-platform',
        outcome: 'exception',
        eventTimestamp: Date.now(),
        wallTime: 5,
        cpuTime: 1,
        event: { request: { url: 'https://x.test/' }, response: { status: 500 } },
        logs: [],
        exceptions: [{ name: 'Error', message, timestamp: Date.now() }],
        diagnosticsChannelEvents: [],
        scriptTags: [],
        scriptVersion: { id: 'v' },
        entrypoint: 'SshGateway',
      }) as unknown as TraceItem;
    const count = (message: string) =>
      aggregate([event(message)], 'yonedarepo-dev-platform', true)
        .reduce((n, row) => n + row.exceptions, 0);
    expect(count('Durable Object reset because its code was updated.')).toBe(0);
    expect(count('Something real broke')).toBe(1);
  });
});

describe('new signals', () => {
  it('a reconcile mismatch is urgent, mailed at once, and names no account', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await logged(
      d,
      start,
      logLine('billing.reconcile.mismatch', 'error', {
        account: 'acct-secret-name',
        problem: 'amount',
      }),
      'managed_worker',
      MANAGED_SCRIPT,
    );
    await runWatch(e, d);
    expect(await finding(d, 'billing:reconcile_mismatches')).toMatchObject({ level: 'urgent' });
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.subject).toBe('[URGENT dev] 1 billing mismatch with Stripe');
    expect(calls.mail[0].body.text).toContain('docs/incidents.md');
    expect(JSON.stringify([calls.mail, calls.model])).not.toContain('acct-secret-name');
  });

  it('keeps a once-only mismatch open past the next hourly pass, then closes it', async () => {
    fakeUpstreams(analytics());
    const clock = { now: start };
    const e = wideEnv();
    const d = deps(e, clock);
    await logged(
      d,
      clock.now,
      logLine('billing.reconcile.mismatch', 'error', { problem: 'amount' }),
      'managed_worker',
      MANAGED_SCRIPT,
    );
    await runWatch(e, d);
    clock.now += 3 * HOUR;
    await quiet(d, clock.now);
    await runWatch(e, d);
    expect(await keys(d)).toEqual(['billing:reconcile_mismatches']);
    clock.now += 18 * HOUR;
    await quiet(d, clock.now);
    await runWatch(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('storage: 5 GB is silent, 8 GB waits for the digest, 9 GB and the limit are urgent', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    const line = (db_bytes: number) => logLine('repo.storage', 'log', { repo: 'r0', db_bytes });
    await logged(d, start, line(5.1e9));
    await runWatch(e, d);
    expect(await keys(d)).toEqual([]);
    await logged(d, start, line(8.1e9));
    await runWatch(e, d);
    expect(await finding(d, 'storage:storage_8gb')).toMatchObject({ level: 'digest' });
    expect(calls.mail[0].body.subject).toBe('[dev] Repository past 8 GB');
    await logged(d, start, line(9.1e9));
    await runWatch(e, d);
    expect(await finding(d, 'storage:storage_9gb')).toMatchObject({ level: 'urgent' });
    expect(calls.mail[1].body.subject).toBe('[URGENT dev] Repository past 9 GB');
    await logged(d, start, logLine('repo.full', 'log', { repo: 'r0', op: 'repo_land' }));
    await runWatch(e, d);
    expect(await finding(d, 'storage:storage_full')).toMatchObject({ level: 'urgent' });
    expect(calls.mail[2].body.subject).toBe('[URGENT dev] Repository history reached its limit');
  });

  it('dead letters on every queue are urgent', async () => {
    const calls = fakeUpstreams(
      analytics({
        deadLettered: { jobs: 1, checks: 2, managed: 3 },
        deadBacklog: { platform: 3, managed: 3 },
      }),
    );
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    await runWatch(e, d);
    expect(await keys(d)).toEqual([
      'check_runs:dead_lettered',
      'derived_jobs:dead_letter_backlog',
      'derived_jobs:dead_lettered',
      'managed_worker:dead_letter_backlog',
      'managed_worker:dead_lettered',
    ]);
    expect(calls.mail).toHaveLength(1);
    // Each queue's count and its waiting messages are one item.
    expect(calls.mail[0].body.subject).toBe('[URGENT dev] 3 managed agent runs failed +2 more');
    expect((await finding(d, 'check_runs:dead_lettered')).summary).toContain('dead_lettered=2');
  });

  it('counts a failed cron from its outcome and from each logged failure', async () => {
    fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await quiet(d, start);
    await feed(
      d.ledger,
      [
        ...traces({ component: 'cron', count: 60, wallMs: 40, errors: 1 }, recent(start)),
        ...traces(
          {
            component: 'cron',
            count: 1,
            wallMs: 40,
            logs: [
              logLine('undo.sweep_failed', 'error'),
              logLine('compaction.sweep_failed', 'error'),
              logLine('ssh.keepalive_failed', 'error'),
              logLine('billing.reconcile', 'error', { message: 'upstream 500' }),
            ],
          },
          recent(start),
        ),
      ],
      start,
      true,
    );
    await runWatch(e, d);
    expect((await finding(d, 'cron:failed_crons')).summary).toContain('failed_crons=5');
  });

  it('says so when a watched Worker stops running its cron', async () => {
    fakeUpstreams(analytics());
    const e = wideEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start)), start, true);
    await runWatch(e, d);
    expect(await keys(d)).toEqual(['cron:cron_missing']);
  });

  it('watches the dead-man back', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv({ DEADMAN_URL });
    const d = deps(e, { now: start });
    await feed(d.ledger, [...hour(recent(start)), ...traces({ component: 'cron', count: 60, wallMs: 40 }, recent(start))], start, true);
    calls.routes[`${DEADMAN_URL}/health`] = () =>
      Response.json({ service: 'yonedarepo-deadman', last_check_at: start - 2 * HOUR });
    await runWatch(e, d);
    expect(await finding(d, 'deadman:deadman_stale')).toMatchObject({ level: 'digest' });
    calls.routes[`${DEADMAN_URL}/health`] = () =>
      Response.json({ service: 'yonedarepo-deadman', last_check_at: start - 60_000 });
    await feed(d.ledger, traces({ component: 'cron', count: 60, wallMs: 40 }, recent(start)), start, true);
    await runWatch(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('redacts email addresses: account ids can be one, and the model is a third party', () => {
    expect(redact('account ada@example.com failed')).toBe('account [email] failed');
  });

  it('redacts a very long line in bounded time', () => {
    const started = Date.now();
    expect(redact('x'.repeat(1_000_000)).length).toBeLessThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('two levels', () => {
  const siteDown = (calls: ReturnType<typeof fakeUpstreams>) => {
    calls.routes[`${FRONT_URL}/health`] = down;
  };

  it('a site-down quick pass mails at once, with no model call or digest', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const d = deps(e, { now: start });
    expect(await runQuick(e, d)).toMatchObject({ outcome: 'ok', urgent: 1 });
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.subject).toBe('[URGENT dev] Website health check failing');
    expect(calls.model).toHaveLength(0);
    expect((await d.ledger.status(start)).spend.emails).toBe(0);
    expect(await finding(d, 'front_worker:health')).toMatchObject({
      level: 'urgent',
      narrative_status: 'pending',
    });
  });

  it('a quick pass files no digest finding and resolves what it can see', async () => {
    const calls = fakeUpstreams(analytics({ backlog: [5, 400] }));
    siteDown(calls);
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await quiet(d, clock.now);
    await runQuick(e, d);
    expect(await keys(d)).toEqual(['front_worker:health']);
    delete calls.routes[`${FRONT_URL}/health`];
    calls.routes[`${FRONT_URL}/health`] = () => Response.json({ service: 'yonedarepo' });
    clock.now += 5 * 60_000;
    await runQuick(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('one failed probe is retried before it counts as down', async () => {
    const calls = fakeUpstreams(analytics());
    let answers = 0;
    calls.routes[`${FRONT_URL}/health`] = () =>
      answers++ === 0 ? down() : Response.json({ service: 'yonedarepo' });
    const e = wideEnv();
    const d = deps(e, { now: start });
    await runQuick(e, d);
    expect(answers).toBe(2);
    expect(await keys(d)).toEqual([]);
  });

  it('a full pass and a quick pass agree on the finding, however the rest of the report looks', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await runQuick(e, d);
    clock.now += 2 * 60_000;
    await feed(
      d.ledger,
      traces(
        { component: 'front_worker', count: 25, wallMs: 40, errors: 5, script: FRONT_SCRIPT },
        recent(clock.now),
      ),
      clock.now,
      true,
    );
    await runWatch(e, d);
    expect(calls.mail.filter(urgentMail)).toHaveLength(1);
    expect((await finding(d, 'front_worker:health')).occurrences).toBe(2);
    expect(await keys(d)).toContain('front_worker:error_rate+exceptions');
  });

  it('the daily digest cap never holds an urgent alert', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const d = deps(e, { now: start });
    await d.ledger.observe(
      {
        key: 'seed:one',
        component: 'seed',
        kind: 'telemetry',
        level: 'digest',
        signals: [],
        summary: 's',
      },
      start,
    );
    for (let i = 0; i < DAILY_EMAIL_CAP; i++) await d.ledger.claimNotice(start, DAILY_EMAIL_CAP, 20);
    await runQuick(e, d);
    expect(calls.mail).toHaveLength(1);
    expect(urgentMail(calls.mail[0])).toBe(true);
    expect((await d.ledger.status(start)).spend.emails).toBe(DAILY_EMAIL_CAP);
  });

  it('a digest never carries an urgent finding held by the repeat limit', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    await runQuick(e, d);
    expect(calls.mail).toHaveLength(1);
    // Back up, then down again inside the gap: held, and it stays out of the digest.
    delete calls.routes[`${FRONT_URL}/health`];
    calls.routes[`${FRONT_URL}/health`] = () => Response.json({ service: 'yonedarepo' });
    clock.now += 5 * 60_000;
    await runQuick(e, d);
    siteDown(calls);
    clock.now += 5 * 60_000;
    await feed(d.ledger, hour(recent(clock.now)), clock.now, true);
    await runWatch(e, d);
    expect(calls.mail.filter((m) => m.body.text.includes('Website health'))).toHaveLength(1);
  });

  it('stays quiet about a problem that has not gone away', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    for (let i = 0; i < 24; i++) {
      await runQuick(e, d);
      clock.now += 5 * 60_000;
    }
    expect(calls.mail).toHaveLength(1);
  });

  it('limits a flapping signal to one mail a gap and a day cap, and starts again next UTC day', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv();
    const clock = { now: Date.parse('2026-10-20T00:02:00Z') };
    const d = deps(e, clock);
    const flips = (24 * HOUR - 10 * 60_000) / (5 * 60_000);
    for (let i = 0; i < flips; i++) {
      calls.routes[`${FRONT_URL}/health`] =
        i % 2 ? () => Response.json({ service: 'yonedarepo' }) : down;
      await runQuick(e, d);
      clock.now += 5 * 60_000;
    }
    const urgent = () => calls.mail.filter(urgentMail);
    expect(urgent()).toHaveLength(URGENT_PER_DAY);
    const sent = URGENT_PER_DAY;
    calls.routes[`${FRONT_URL}/health`] = down;
    clock.now = Date.parse('2026-10-21T00:02:00Z');
    await runQuick(e, d);
    expect(urgent()).toHaveLength(sent + 1);
  });

  it('holds a second mail for one signal until the gap has passed', async () => {
    const calls = fakeUpstreams(analytics());
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    const flip = async (up: boolean) => {
      calls.routes[`${FRONT_URL}/health`] = up
        ? () => Response.json({ service: 'yonedarepo' })
        : down;
      await runQuick(e, d);
    };
    await flip(false);
    clock.now += 60_000;
    await flip(true);
    clock.now += 60_000;
    await flip(false);
    expect(calls.mail).toHaveLength(1);
    clock.now = start + URGENT_GAP_MS;
    await flip(false);
    expect(calls.mail).toHaveLength(2);
  });

  it('a failed send gives its turn back and goes out on the next pass', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = wideEnv();
    const clock = { now: start };
    const d = deps(e, clock);
    calls.mailAnswer = () => new Response('{}', { status: 500 });
    await runQuick(e, d);
    expect(log.mock.calls[0][0]).toContain('"status":500');
    expect((await finding(d, 'front_worker:health')).notified_at).toBeNull();
    calls.mailAnswer = () => Response.json({ id: 'fixture-email' });
    clock.now += 5 * 60_000;
    await runQuick(e, d);
    expect(calls.mail).toHaveLength(2);
    expect((await finding(d, 'front_worker:health')).notified_at).not.toBeNull();
    // The retry repeats the key, so a send whose answer was lost is not delivered twice.
    expect(calls.mail[1].headers.get('idempotency-key')).toBe(
      calls.mail[0].headers.get('idempotency-key'),
    );
  });

  it('mails the urgent alert before any model call can hold it up', async () => {
    const calls = fakeUpstreams(analytics());
    siteDown(calls);
    const e = wideEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start)), start, true);
    await feed(
      d.ledger,
      traces({ component: 'cron', count: 60, wallMs: 40 }, recent(start)),
      start,
      true,
    );
    let mailedBeforeModel: boolean | undefined;
    const write = d.model?.write.bind(d.model);
    if (d.model && write)
      d.model.write = (prompt) => {
        mailedBeforeModel = calls.mail.length === 1;
        return write(prompt);
      };
    await runWatch(e, d);
    expect(mailedBeforeModel).toBe(true);
  });

  it('with the switch off, nothing is urgent, nothing new fires and quick passes stop', async () => {
    const calls = fakeUpstreams(
      analytics({ deadLettered: { jobs: 1 }, checksBacklog: [5, 400] }),
    );
    const e = wideEnv({ WATCH_WIDE: undefined });
    const d = deps(e, { now: start });
    expect(await runQuick(e, d)).toEqual({ outcome: 'off', urgent: 0 });
    calls.routes['https://yonedarepo-dev-platform.example.workers.dev/health'] = down;
    await feed(d.ledger, hour(recent(start)), start);
    await feed(
      d.ledger,
      traces(
        {
          component: 'derived_jobs',
          count: 1,
          wallMs: 60,
          logs: [logLine('repo.storage', 'log', { db_bytes: 9.1e9 })],
        },
        recent(start),
      ),
      start,
    );
    await runWatch(e, d);
    const findings = await d.ledger.findings('open', 10);
    expect(findings.map((f) => f.dedup_key).sort()).toEqual([
      'api_worker:health',
      'derived_jobs:dead_lettered',
    ]);
    expect(findings.every((f) => f.level === 'digest')).toBe(true);
    expect(calls.mail).toHaveLength(1);
    expect(calls.mail[0].body.subject).toBe('[dev] API health check failing +1 more');
  });
});

describe('cron dispatch', () => {
  it('names the cron the dev spec declares', () => {
    const superfan = JSON.parse(devSpec).workers.find(
      (w: { role: string }) => w.role === 'superfan',
    );
    expect(superfan.config.triggers.crons).toContain(QUICK_CRON);
  });

  it('runs a quick pass on the five-minute cron and a full pass on the hourly one', async () => {
    const calls = fakeUpstreams(analytics());
    const { default: worker } = await import('../../cloudflare/superfan/index');
    const e = wideEnv();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    await worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, e, ctx);
    await Promise.all(waits);
    const status = async () =>
      (
        await superfanFetch(
          new Request('https://superfan.example/heartbeat'),
          e,
        )
      ).json();
    const first = await status();
    expect(first.quick_at).toEqual(expect.any(Number));
    expect(calls.model).toHaveLength(0);
    await worker.scheduled({ cron: '7 * * * *' } as ScheduledController, e, ctx);
    await Promise.all(waits);
    expect((await status()).full_at).toEqual(expect.any(Number));
  });
});
