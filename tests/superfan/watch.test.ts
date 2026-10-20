import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyCap } from '../../cloudflare/superfan/config';
import { runWatch } from '../../cloudflare/superfan/watch';
import {
  ANALYTICS_TOKEN,
  analytics,
  deps,
  fakeUpstreams,
  MODEL_KEY,
  testEnv,
} from './fake-platform';

const HOUR = 60 * 60_000;
const start = Date.parse('2026-10-20T15:07:00Z');
afterEach(() => vi.restoreAllMocks());

describe('superfan watch pass', () => {
  it('reads one GraphQL request and calls no model while signals are quiet', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv();
    const d = deps(e, { now: start });
    const result = await runWatch(e, d);
    expect(result).toEqual({ outcome: 'ok', anomalies: 0, modelCalls: 0, findings: [] });
    expect(calls.graphql).toHaveLength(1);
    expect(new Headers(calls.graphql[0].headers).get('authorization')).toBe(
      `Bearer ${ANALYTICS_TOKEN}`,
    );
    expect(calls.model).toHaveLength(0);
    expect(await d.ledger.findings('all', 10)).toEqual([]);
  });

  it('turns an anomaly into one finding written by the cheap model', async () => {
    const calls = fakeUpstreams(analytics({ repoErrors: 90 }));
    const e = testEnv();
    const d = deps(e, { now: start });
    const result = await runWatch(e, d);
    expect(result).toMatchObject({ outcome: 'ok', anomalies: 1, modelCalls: 1 });
    expect(calls.model).toHaveLength(1);
    const [call] = calls.model;
    expect(call.headers.get('api-key')).toBe(MODEL_KEY);
    expect(call.body).toMatchObject({
      model: 'mimo-v2.6-flash',
      max_tokens: 400,
      thinking: { type: 'disabled' },
    });
    const [finding] = await d.ledger.findings('open', 10);
    expect(finding).toMatchObject({
      dedup_key: 'source_repository:error_rate',
      component: 'source_repository',
      narrative_status: 'written',
      model: 'mimo-v2.6-flash',
      occurrences: 1,
      narrative: { title: 'SourceRepository errors at 10%' },
    });
    expect(finding.summary).toContain('error_rate=0.1');
    // 900 input + 120 output tokens at $0.14 / $0.28 per million.
    expect(finding.cost_microusd).toBe(Math.ceil((900 * 140_000 + 120 * 280_000) / 1e6));
    const status = await d.ledger.status(start);
    expect(status.spend).toMatchObject({ reserved: 0, settled: finding.cost_microusd, calls: 1 });
    expect(JSON.stringify(finding)).not.toContain(MODEL_KEY);
  });

  it('deduplicates a persisting problem and resolves it once quiet', async () => {
    const clock = { now: start };
    const e = testEnv();
    const d = deps(e, clock);
    let calls = fakeUpstreams(analytics({ repoErrors: 90 }));
    await runWatch(e, d);
    clock.now += HOUR;
    await runWatch(e, d);
    expect(calls.model).toHaveLength(1);
    const [open] = await d.ledger.findings('all', 10);
    expect(open).toMatchObject({ status: 'open', occurrences: 2 });

    vi.restoreAllMocks();
    calls = fakeUpstreams(analytics());
    clock.now += HOUR;
    await runWatch(e, d);
    expect(await d.ledger.findings('all', 10)).toMatchObject([{ id: open.id, status: 'resolved' }]);

    // Back within six hours: the finding reopens, the model is not asked again.
    vi.restoreAllMocks();
    calls = fakeUpstreams(analytics({ repoErrors: 90 }));
    clock.now += HOUR;
    await runWatch(e, d);
    expect(calls.model).toHaveLength(0);
    expect(await d.ledger.findings('all', 10)).toMatchObject([
      { id: open.id, status: 'open', occurrences: 3 },
    ]);
  });

  it('stops model calls at the daily cap and keeps the deterministic summary', async () => {
    const calls = fakeUpstreams(analytics({ repoErrors: 90, backlog: [5, 400] }));
    const e = testEnv({ DAILY_CAP_MICROUSD: '1' });
    const d = deps(e, { now: start });
    const result = await runWatch(e, d);
    expect(result).toMatchObject({ anomalies: 2, modelCalls: 0 });
    expect(calls.model).toHaveLength(0);
    const findings = await d.ledger.findings('open', 10);
    expect(findings.map((f) => f.narrative_status)).toEqual([
      'budget_exhausted',
      'budget_exhausted',
    ]);
    expect(findings.map((f) => f.dedup_key).sort()).toEqual([
      'derived_jobs:backlog+backlog_growth',
      'source_repository:error_rate',
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
    fakeUpstreams(analytics({ repoP95Ms: 900 }));
    expect((await runWatch(e, deps(e, clock))).anomalies).toBe(0); // no baseline yet
    const d = deps(e, clock);
    vi.restoreAllMocks();
    fakeUpstreams(analytics({ repoP95Ms: 80 }));
    for (let i = 0; i < 3; i++) {
      clock.now += HOUR;
      await runWatch(e, d);
    }
    vi.restoreAllMocks();
    fakeUpstreams(analytics({ repoP95Ms: 900 }));
    clock.now += HOUR;
    expect(await runWatch(e, d)).toMatchObject({ anomalies: 1, modelCalls: 1 });
    const [finding] = await d.ledger.findings('open', 1);
    expect(finding.dedup_key).toBe('source_repository:p95_wall_ms');
  });

  it('reports a telemetry failure as a finding, without the token and without a model call', async () => {
    const calls = fakeUpstreams(() => new Response('upstream down', { status: 503 }));
    const e = testEnv();
    const d = deps(e, { now: start });
    expect(await runWatch(e, d)).toMatchObject({ outcome: 'telemetry_failed' });
    expect(calls.model).toHaveLength(0);
    const [finding] = await d.ledger.findings('open', 10);
    expect(finding).toMatchObject({
      dedup_key: 'telemetry:fetch_failed',
      kind: 'telemetry',
      narrative_status: 'deterministic',
      summary: 'GraphQL HTTP 503',
    });
    expect(JSON.stringify(finding)).not.toContain(ANALYTICS_TOKEN);
  });

  it('reports GraphQL errors and a missing token as distinct telemetry findings', async () => {
    fakeUpstreams(() =>
      Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }),
    );
    const e = testEnv();
    const d = deps(e, { now: start });
    await runWatch(e, d);
    const noToken = testEnv({ CF_ANALYTICS_TOKEN: undefined });
    const d2 = deps(noToken, { now: start });
    await runWatch(noToken, d2);
    expect((await d.ledger.findings('open', 1))[0].summary).toBe(
      'GraphQL error: not authorized for that account',
    );
    expect((await d2.ledger.findings('open', 1))[0]).toMatchObject({
      dedup_key: 'telemetry:token_missing',
      summary: 'Waiting on the CF_ANALYTICS_TOKEN secret',
    });
  });

  it('refuses to watch production', async () => {
    const calls = fakeUpstreams(analytics());
    const e = testEnv({
      WATCH_SCRIPT: 'yonedarepo-dev',
      WATCH_URL: 'https://yonedarepo-dev.example.workers.dev',
    });
    const d = deps(e, { now: start });
    await runWatch(e, d);
    expect(calls.graphql).toHaveLength(0);
    expect((await d.ledger.findings('open', 1))[0].summary).toBe(
      'Configuration: WATCH_SCRIPT must name the isolated platform-only Worker',
    );
  });

  it('never falls back to another model', async () => {
    const calls = fakeUpstreams(analytics({ repoErrors: 90 }));
    const e = testEnv({ SUPERFAN_MODEL: 'glm-5.3' });
    const d = deps(e, { now: start });
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
