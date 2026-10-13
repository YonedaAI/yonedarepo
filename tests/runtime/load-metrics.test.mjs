import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latency, summarize } from '../../tools/load-metrics.mjs';

test('nearest-rank percentiles preserve input and represent empty observations honestly', () => {
  assert.deepEqual(latency([]), { samples: 0, p50_ms: null, p95_ms: null, max_ms: null });
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(latency(values), { samples: 100, p50_ms: 50, p95_ms: 95, max_ms: 100 });
  assert.equal(values[0], 100);
});

test('throughput separates successful commands, expected fencing and unexpected errors', () => {
  const result = summarize(
    [
      { op: 'claim', ms: 2, code: 'OK', expected: false },
      { op: 'claim', ms: 8, code: 'LEASE_HELD', expected: true },
      { op: 'start_run', ms: 20, code: 'UNCLASSIFIED', expected: false },
    ],
    1000,
  );
  assert.equal(result.attempted_commands_per_second, 3);
  assert.equal(result.successful_commands_per_second, 1);
  assert.equal(result.expected_rejections, 1);
  assert.equal(result.unexpected_errors, 1);
  assert.deepEqual(result.error_codes, { LEASE_HELD: 1, UNCLASSIFIED: 1 });
  assert.equal(result.successful_latency.p95_ms, 2);
  assert.equal(result.by_operation.claim.p95_ms, 8);
});
