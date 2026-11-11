import { expect, it } from 'vitest';
import type { OperationRow } from '../../../../shared/operation-metrics';
import { nextOperationSort, sortOperationRows } from './adminOperationModel';

const row = (
  operation: string,
  p95: number | null,
  source: OperationRow['source'] = 'rest',
): OperationRow => ({
  operation,
  p95,
  source,
  kind: 'request',
  traffic: 'ordinary',
  actor: 'unknown',
  outcome: 'ok',
  requests: 1,
  p50: null,
  p99: null,
  queueWaitP95: null,
  estimated: false,
});
it('orders actual durations numerically and keeps unknowns last in either direction', () => {
  const rows = [
    row('seconds', 2000),
    row('missing', null),
    row('zero', 0),
    row('milliseconds', 80),
  ];
  expect(sortOperationRows(rows, { key: 'p95', direction: 'asc' }).map((r) => r.operation)).toEqual(
    ['zero', 'milliseconds', 'seconds', 'missing'],
  );
  expect(
    sortOperationRows(rows, { key: 'p95', direction: 'desc' }).map((r) => r.operation),
  ).toEqual(['seconds', 'milliseconds', 'zero', 'missing']);
  expect(rows.map((r) => r.operation)).toEqual(['seconds', 'missing', 'zero', 'milliseconds']);
});
it('sorts visible trigger labels and preserves distinct rows with equal values', () => {
  const rows = [
    row('site', 1, 'web'),
    row('tool', 1, 'mcp'),
    row('api', 1, 'rest'),
    row('api2', 1, 'rest'),
  ];
  expect(
    sortOperationRows(rows, { key: 'source', direction: 'asc' }).map((r) => r.operation),
  ).toEqual(['api', 'api2', 'tool', 'site']);
});
it('toggles the active column and starts new number columns from the highest value', () => {
  expect(nextOperationSort({ key: 'requests', direction: 'desc' }, 'requests')).toEqual({
    key: 'requests',
    direction: 'asc',
  });
  expect(nextOperationSort({ key: 'requests', direction: 'desc' }, 'p95')).toEqual({
    key: 'p95',
    direction: 'desc',
  });
  expect(nextOperationSort({ key: 'requests', direction: 'desc' }, 'operation')).toEqual({
    key: 'operation',
    direction: 'asc',
  });
});
