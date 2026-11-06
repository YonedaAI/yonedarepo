import { expect, it } from 'vitest';
import { aggregate } from '../../cloudflare/superfan/tail';
import { evaluate } from '../../cloudflare/superfan/signals';
import { SCRIPT, traces } from './fake-platform';

const analytics = () => ({ queue: { backlogLatest: 0, backlogEarliest: 0, lagMs: null, retries: 0, deadLettered: 0, deadLetterBacklog: 0 }, checks: null, managed: null, objectKills: { source_repository: 0, check_runs: 0 }, containers: { maxDiskPercent: null }, window: { start: '', end: '' } });
const now = Date.parse('2026-11-05T15:07:00Z');
const report = (tail: any, queue = analytics().queue, marks = {}) => evaluate({
  window: { start: new Date(now - 3600000).toISOString(), end: new Date(now).toISOString() },
  health: { ok: true, status: 200, service: 'yonedarepo-platform' } as any,
  tail, marks, analytics: { ...analytics(), queue },
}, {}, true);

it('does not call a completed delayed message an active queue wait', () => {
  const queue = { ...analytics().queue, backlogLatest: 0, backlogEarliest: 0, lagMs: 43201161 };
  const signal = report({}, queue).find(r => r.component === 'derived_jobs')!.signals.find(s => s.name === 'lag_ms');
  expect(signal).toMatchObject({ value: 43201161, anomalous: false });
  expect(report({}, queue, { queue_late: 1 }).find(r => r.component === 'derived_jobs')!.anomalous).toBe(true);
});

it('separates alarm and keep-alive calls from SSH request counters', () => {
  const base = traces({ component: 'ssh_gateway', count: 1, errors: 1, wallMs: 140146 }, now)[0];
  const events = [
    { ...base, event: { scheduledTime: new Date(now) } },
    { ...base, event: { rpcMethod: 'keepAlive' }, exceptions: [], outcome: 'ok' },
    { ...base, event: { rpcMethods: ['keepAlive'], rpcCallCount: 1 }, exceptions: [], outcome: 'ok' },
    { ...base, event: { rpcMethod: 'connect' } },
  ] as unknown as TraceItem[];
  const rows = aggregate(events, SCRIPT, true);
  expect(rows.find(r => String(r.component) === 'ssh_maintenance')).toMatchObject({ invocations: 3, errors: 1, exceptions: 1 });
  expect(rows.find(r => r.component === 'ssh_gateway')).toMatchObject({ invocations: 1, errors: 1 });
  // A single real failure is retained; repeated background failures still raise an alert.
  const t = { invocations: 95, errors: 2, exceptions: 2, errorLogs: 0, resourceKills: 0, pushRetries: 0, p95WallMs: 189384, samples: [] };
  const background = report({ ssh_maintenance: t }).find(r => String(r.component) === 'ssh_maintenance')!;
  expect(background.anomalous).toBe(false);
  expect(report({ ssh_maintenance: { ...t, errors: 3, exceptions: 3 } }).find(r => String(r.component) === 'ssh_maintenance')!.anomalous).toBe(true);
  expect(report({ ssh_gateway: { ...t, invocations: 20, errors: 1, exceptions: 1 } }).find(r => r.component === 'ssh_gateway')!.anomalous).toBe(true);
});
