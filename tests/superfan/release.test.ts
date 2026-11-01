// A release against the one before it. Traffic, commits and times are invented; nothing leaves
// the test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeployRow } from '../../cloudflare/superfan/ledger-deploys';
import { renderNotice } from '../../cloudflare/superfan/mail-render';
import { releaseWindows, SETTLE_MS, WATCH_MS } from '../../cloudflare/superfan/release';
import { runWatch } from '../../cloudflare/superfan/watch';
import { analytics, deps, fakeUpstreams, feed, traces, hour, testEnv } from './fake-platform';

const MINUTE = 60_000;
const deployed = Date.parse('2026-10-20T15:07:00Z');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const row = (revision: string, finished: number, over: Partial<DeployRow> = {}): DeployRow => ({
  revision,
  env: 'dev',
  who: 'someone',
  kind: 'deploy',
  outcome: 'ok',
  started_at: finished - 2 * MINUTE,
  finished_at: finished,
  ...over,
});
const on = () => testEnv({ RELEASE_COMPARE: 'on' });
afterEach(() => vi.restoreAllMocks());

/** A ledger with two deploys, clean traffic before the new one and `after` following it. */
async function scenario(after: Parameters<typeof hour>[1], e = on(), now = deployed + 40 * MINUTE) {
  fakeUpstreams(analytics());
  const d = deps(e, { now });
  await d.ledger.recordDeploy(row(OLD, deployed - 3 * 60 * MINUTE));
  await d.ledger.recordDeploy(row(NEW, deployed));
  await feed(d.ledger, hour(deployed - 20 * MINUTE), now);
  await feed(d.ledger, hour(deployed + 20 * MINUTE, after), now);
  return d;
}
const keys = async (d: Awaited<ReturnType<typeof scenario>>) =>
  (await d.ledger.findings('open', 20)).map((f) => f.dedup_key);

describe('comparing releases', () => {
  it('files a finding when a release fails more than the one before', async () => {
    const e = on();
    const d = await scenario({ api_worker: { status: 500 } }, e);
    await runWatch(e, d);
    const found = (await d.ledger.findings('open', 20)).find(
      (f) => f.dedup_key === 'api_worker:release_error_rate',
    );
    expect(found).toMatchObject({ level: 'digest', status: 'open' });
    expect(found?.summary).toContain('release_error_rate=1');
    const { text, subject } = renderNotice({ env: 'dev', site: '', api: '' }, found ? [found] : []);
    expect(subject).toContain('API calls fail more since the deploy');
    expect(text).toContain('100% of calls fail, against 0% before it.');
  });

  it('files a finding when a release is twice as slow', async () => {
    const e = on();
    const d = await scenario({ source_repository: { wallMs: 900 } }, e);
    await runWatch(e, d);
    expect(await keys(d)).toContain('source_repository:release_p95_ms');
    const found = (await d.ledger.findings('open', 20)).find(
      (f) => f.dedup_key === 'source_repository:release_p95_ms',
    );
    expect(renderNotice({ env: 'dev', site: '', api: '' }, found ? [found] : []).text).toMatch(
      /The slowest calls take [\d,.]+ (ms|s), against [\d,.]+ ms before it\./,
    );
  });

  it('says nothing about a release like the one before', async () => {
    const e = on();
    const d = await scenario({}, e);
    await runWatch(e, d);
    expect(await keys(d)).toEqual([]);
  });

  it('reads as nothing with RELEASE_COMPARE off', async () => {
    const e = testEnv();
    const d = await scenario({ api_worker: { status: 500 } }, e);
    await runWatch(e, d);
    expect((await keys(d)).filter((k) => k.includes('release_'))).toEqual([]);
  });

  it('needs traffic on both sides', async () => {
    const e = on();
    fakeUpstreams(analytics());
    const now = deployed + 40 * MINUTE;
    const d = deps(e, { now });
    await d.ledger.recordDeploy(row(OLD, deployed - 3 * 60 * MINUTE));
    await d.ledger.recordDeploy(row(NEW, deployed));
    const few = traces(
      { component: 'api_worker', count: 19, wallMs: 50, status: 500 },
      deployed + 20 * MINUTE,
    );
    await feed(d.ledger, [...hour(deployed - 20 * MINUTE), ...few], now);
    await runWatch(e, d);
    expect((await keys(d)).filter((k) => k.includes('release_'))).toEqual([]);
  });

  it('ends a finding once the window closes, and when the switch goes off', async () => {
    const clock = { now: deployed + 40 * MINUTE };
    const e = on();
    const d = await scenario({ api_worker: { status: 500 } }, e, clock.now);
    await runWatch(e, d);
    expect(await keys(d)).toContain('api_worker:release_error_rate');
    clock.now = deployed + WATCH_MS + MINUTE;
    const later = { ...d, now: () => clock.now };
    await feed(d.ledger, hour(clock.now - 10 * MINUTE), clock.now);
    await runWatch(e, later);
    expect(await keys(d)).not.toContain('api_worker:release_error_rate');

    const off = testEnv();
    const again = await scenario({ api_worker: { status: 500 } }, e);
    await runWatch(e, again);
    expect(await keys(again)).toContain('api_worker:release_error_rate');
    const quiet = deployed + 50 * MINUTE;
    await feed(again.ledger, hour(quiet - 5 * MINUTE), quiet);
    await runWatch(off, { ...again, now: () => quiet });
    expect((await keys(again)).filter((k) => k.includes('release_'))).toEqual([]);
  });

  it('compares after a rollback too, and skips a failed deploy', async () => {
    fakeUpstreams(analytics());
    const now = deployed + 40 * MINUTE;
    const d = deps(on(), { now });
    await d.ledger.recordDeploy(row(OLD, deployed - 3 * 60 * MINUTE));
    await d.ledger.recordDeploy(row(NEW, deployed - 60 * MINUTE, { outcome: 'failed' }));
    await d.ledger.recordDeploy(row(OLD, deployed, { kind: 'rollback', started_at: deployed - 1 }));
    expect(await d.ledger.compareReleases(now)).toMatchObject({ revision: OLD, previous: OLD });
  });
});

describe('the windows', () => {
  const previous = row(OLD, deployed - 3 * 60 * MINUTE);
  const current = row(NEW, deployed);

  it('leaves out the rollout and the settling minutes, and matches lengths', () => {
    const now = deployed + 45 * MINUTE;
    const { after, before } = releaseWindows(current, previous, now) ?? { after: [], before: [] };
    expect(after[0]).toBeGreaterThanOrEqual(deployed + SETTLE_MS);
    expect(before[1]).toBeLessThanOrEqual(current.started_at);
    expect(after[1] - after[0]).toBe(before[1] - before[0]);
  });

  it('stops at the deploy before, past its settling minutes', () => {
    const near = row(OLD, deployed - 12 * MINUTE);
    const windows = releaseWindows(current, near, deployed + 2 * 60 * MINUTE);
    expect(windows?.before[0]).toBeGreaterThanOrEqual(near.finished_at + SETTLE_MS);
  });

  it('has nothing to compare at first, after the watch, or between close deploys', () => {
    expect(releaseWindows(current, previous, deployed + MINUTE)).toBeNull();
    expect(releaseWindows(current, previous, deployed + WATCH_MS + 1)).toBeNull();
    expect(releaseWindows(current, row(OLD, deployed - 4 * MINUTE), deployed + 40 * MINUTE)).toBeNull();
  });
});
