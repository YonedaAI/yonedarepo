import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyCap } from '../../cloudflare/superfan/config';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  ANALYTICS_TOKEN,
  analytics,
  deps,
  fakeUpstreams,
  feed,
  hour,
  MODEL_KEY,
  testEnv,
  traces,
} from './fake-platform';

const HOUR = 60 * 60_000;
const start = Date.parse('2026-10-20T15:07:00Z');
const recent = (now: number) => now - 10 * 60_000;
afterEach(() => vi.restoreAllMocks());

describe('superfan watch pass', () => {
  it('reads tail counters and one GraphQL request, and calls no model while quiet', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start)), start);
    expect(await runWatch(e, d)).toEqual({
      outcome: 'ok',
      anomalies: 0,
      modelCalls: 0,
      findings: [],
    });
    expect(calls.graphql).toHaveLength(1);
    expect(new Headers(calls.graphql[0].headers).get('authorization')).toBe(
      `Bearer ${ANALYTICS_TOKEN}`,
    );
    expect(calls.model).toHaveLength(0);
    expect(await d.ledger.findings('all', 10)).toEqual([]);
  });

  it('turns an anomaly into one finding written by the cheap model', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start), { source_repository: { errors: 20 } }), start);
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'ok', anomalies: 1, modelCalls: 1 });
    expect(calls.model).toHaveLength(1);
    const [call] = calls.model;
    expect(call.headers.get('api-key')).toBe(MODEL_KEY);
    expect(call.body).toMatchObject({
      model: 'mimo-v2.6-flash',
      max_tokens: 400,
      thinking: { type: 'disabled' },
    });
    // Exception text reaches the model and the ledger only after redaction.
    expect(call.body.messages[0].content).toContain('Bearer [redacted]');
    expect(call.body.messages[0].content).not.toContain('abc.def.ghi');
    const [finding] = await d.ledger.findings('open', 10);
    expect(finding).toMatchObject({
      dedup_key: 'source_repository:error_rate+exceptions',
      narrative_status: 'written',
      model: 'mimo-v2.6-flash',
      occurrences: 1,
      narrative: { title: 'SourceRepository errors at 10%' },
    });
    expect(finding.summary).toContain('error_rate=0.1');
    // 900 input + 120 output tokens at $0.14 / $0.28 per million.
    expect(finding.cost_microusd).toBe(Math.ceil((900 * 140_000 + 120 * 280_000) / 1e6));
    expect((await d.ledger.status(start)).spend).toMatchObject({
      reserved: 0,
      settled: finding.cost_microusd,
      calls: 1,
    });
    expect(JSON.stringify(finding)).not.toContain(MODEL_KEY);
    expect(JSON.stringify(finding)).not.toContain('abc.def.ghi');
  });

  it('deduplicates a persisting problem, resolves it once quiet and reopens it cheaply', async () => {
    const clock = { now: start };
    const e = testEnv();
    const d = deps(e, clock);
    const calls = fakeUpstreams(analytics());
    const run = async (errors: number) => {
      await feed(d.ledger, hour(recent(clock.now), { source_repository: { errors } }), clock.now);
      await runWatch(e, d);
      clock.now += HOUR;
    };
    await run(20);
    await run(20);
    expect(calls.model).toHaveLength(1);
    const [open] = await d.ledger.findings('all', 10);
    expect(open).toMatchObject({ status: 'open', occurrences: 2 });
    await run(0);
    expect(await d.ledger.findings('all', 10)).toMatchObject([{ id: open.id, status: 'resolved' }]);
    await run(20);
    expect(calls.model).toHaveLength(1);
    expect(await d.ledger.findings('all', 10)).toMatchObject([
      { id: open.id, status: 'open', occurrences: 3 },
    ]);
  });

  it('stops model calls at the daily cap and keeps the deterministic summary', async () => {
    const calls = fakeUpstreams(analytics({ backlog: [5, 400] }));
    const e = testEnv({ DAILY_CAP_MICROUSD: '1' });
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start), { source_repository: { errors: 20 } }), start);
    expect(await runWatch(e, d)).toMatchObject({ anomalies: 2, modelCalls: 0 });
    expect(calls.model).toHaveLength(0);
    const findings = await d.ledger.findings('open', 10);
    expect(findings.map((f) => f.narrative_status)).toEqual([
      'budget_exhausted',
      'budget_exhausted',
    ]);
    expect(findings.map((f) => f.dedup_key).sort()).toEqual([
      'derived_jobs:backlog+backlog_growth',
      'source_repository:error_rate+exceptions',
    ]);
    expect((await d.ledger.status(start)).spend).toMatchObject({ settled: 0, refused: 2 });
  });

  it('never configures a cap above $1.00 a day', () => {
    expect(dailyCap(testEnv({ DAILY_CAP_MICROUSD: '50000000' }))).toBe(1_000_000);
    expect(dailyCap(testEnv({ DAILY_CAP_MICROUSD: 'lots' }))).toBe(0);
  });

  it('enforces the cap across calls in the ledger', async () => {
    const d = deps(testEnv(), { now: start });
    expect(await d.ledger.reserve(start, 600_000, 1_000_000)).toBeTypeOf('string');
    expect(await d.ledger.reserve(start, 500_000, 1_000_000)).toBeNull();
    // A new UTC day starts a new counter.
    expect(await d.ledger.reserve(start + 24 * HOUR, 500_000, 1_000_000)).toBeTypeOf('string');
  });

  it('flags p95 drift only after a quiet baseline exists', async () => {
    const clock = { now: start };
    const e = testEnv();
    fakeUpstreams(analytics());
    const slow = { source_repository: { wallMs: 900 } };
    const fresh = deps(e, clock);
    await feed(fresh.ledger, hour(recent(clock.now), slow), clock.now);
    expect((await runWatch(e, fresh)).anomalies).toBe(0); // no baseline yet
    const d = deps(e, clock);
    for (let i = 0; i < 3; i++) {
      clock.now += HOUR;
      await feed(d.ledger, hour(recent(clock.now)), clock.now);
      await runWatch(e, d);
    }
    clock.now += HOUR;
    await feed(d.ledger, hour(recent(clock.now), slow), clock.now);
    expect(await runWatch(e, d)).toMatchObject({ anomalies: 1, modelCalls: 1 });
    const [finding] = await d.ledger.findings('open', 1);
    expect(finding.dedup_key).toBe('source_repository:p95_wall_ms');
    expect(finding.summary).toContain('baseline 85ms');
  });

  it('counts Artifacts push retries from platform logs', async () => {
    fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    const retry = { level: 'warn', message: ['object store push attempt 2 refused: busy'] };
    await feed(d.ledger, hour(recent(start), { api_worker: { count: 100, logs: [] } }), start);
    await feed(
      d.ledger,
      traces({ component: 'api_worker', count: 8, wallMs: 60, logs: [retry] }, recent(start)),
      start,
    );
    await runWatch(e, d);
    const [finding] = await d.ledger.findings('open', 1);
    expect(finding.dedup_key).toBe('object_push_queue:push_retries');
    expect(finding.summary).toContain('push_retries=8');
  });

  it('reports silent tail events as a finding but still evaluates analytics', async () => {
    const calls = fakeUpstreams(analytics({ backlog: [5, 400] }));
    const e = testEnv();
    const d = deps(e, { now: start });
    // Events from production never count, even if delivered.
    await feed(
      d.ledger,
      hour(recent(start)).map((t) => ({ ...t, scriptName: 'yonedarepo-dev' })),
      start,
    );
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'ok', anomalies: 1 });
    expect(calls.model).toHaveLength(1);
    expect((await d.ledger.findings('open', 10)).map((f) => f.dedup_key).sort()).toEqual([
      'derived_jobs:backlog+backlog_growth',
      'telemetry:tail_silent',
    ]);
  });

  it('keeps analytics findings open while analytics is down, without the token in any finding', async () => {
    const clock = { now: start };
    const e = testEnv();
    const d = deps(e, clock);
    let calls = fakeUpstreams(analytics({ backlog: [5, 400] }));
    await feed(d.ledger, hour(recent(clock.now)), clock.now);
    await runWatch(e, d);
    vi.restoreAllMocks();
    calls = fakeUpstreams(() => new Response('upstream down', { status: 503 }));
    clock.now += HOUR;
    await feed(d.ledger, hour(recent(clock.now)), clock.now);
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'ok', anomalies: 0 });
    expect(calls.model).toHaveLength(0);
    const findings = await d.ledger.findings('open', 10);
    expect(findings.map((f) => [f.dedup_key, f.summary]).sort()).toEqual([
      ['derived_jobs:backlog+backlog_growth', expect.stringContaining('backlog=400')],
      ['telemetry:fetch_failed', 'GraphQL HTTP 503'],
    ]);
    expect(JSON.stringify(findings)).not.toContain(ANALYTICS_TOKEN);
  });

  it('fails the run when neither tail nor analytics can be read', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv({ CF_ANALYTICS_TOKEN: undefined });
    const d = deps(e, { now: start });
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'telemetry_failed' });
    expect(calls.graphql).toHaveLength(0);
    expect((await d.ledger.findings('open', 10)).map((f) => f.summary).sort()).toEqual([
      'No tail events from the platform Worker this hour',
      'Waiting on the CF_ANALYTICS_TOKEN secret',
    ]);
  });

  it('reports GraphQL errors as a telemetry finding', async () => {
    fakeUpstreams(() =>
      Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }),
    );
    const e = testEnv();
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start)), start);
    await runWatch(e, d);
    expect((await d.ledger.findings('open', 1))[0].summary).toBe(
      'GraphQL error: not authorized for that account',
    );
  });

  it('refuses to watch production', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv({
      WATCH_SCRIPT: 'yonedarepo-dev',
      WATCH_URL: 'https://yonedarepo-dev.example.workers.dev',
    });
    const d = deps(e, { now: start });
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'telemetry_failed' });
    expect(calls.graphql).toHaveLength(0);
    expect(await d.ledger.findings('open', 10)).toMatchObject([
      {
        dedup_key: 'telemetry:config',
        summary: 'Configuration: WATCH_SCRIPT must name the isolated platform-only Worker',
        occurrences: 1,
      },
    ]);
  });

  it('never falls back to another model', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv({ SUPERFAN_MODEL: 'glm-5.3' });
    const d = deps(e, { now: start });
    await feed(d.ledger, hour(recent(start), { source_repository: { errors: 20 } }), start);
    await runWatch(e, d);
    expect(calls.model).toHaveLength(0);
    expect((await d.ledger.findings('open', 1))[0].narrative_status).toBe('model_failed');
  });

  it('runs one pass at a time', async () => {
    fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    expect(await d.ledger.startRun(start)).toBeTypeOf('number');
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'busy' });
  });
});
