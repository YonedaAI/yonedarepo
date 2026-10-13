// Portable statistics shared by the workerd benchmark and its offline runner.
export const loadMarker = 'YONEDA_LOAD_RESULT ';

export function latency(values) {
  if (!values.length) return { samples: 0, p50_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    samples: sorted.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted.at(-1),
  };
}

export function summarize(samples, elapsedMs) {
  const successful = samples.filter((sample) => sample.code === 'OK');
  const errors = samples.filter((sample) => sample.code !== 'OK');
  const expected = errors.filter((sample) => sample.expected);
  const byOperation = Object.fromEntries(
    [...new Set(samples.map((sample) => sample.op))].sort().map((op) => {
      const subset = samples.filter((sample) => sample.op === op);
      return [
        op,
        {
          attempted: subset.length,
          ...latency(subset.map((sample) => sample.ms)),
          errors: subset.filter((sample) => sample.code !== 'OK').length,
        },
      ];
    }),
  );
  return {
    attempted: samples.length,
    successful: successful.length,
    elapsed_ms: elapsedMs,
    attempted_commands_per_second: (samples.length * 1000) / elapsedMs,
    successful_commands_per_second: (successful.length * 1000) / elapsedMs,
    expected_rejections: expected.length,
    unexpected_errors: errors.length - expected.length,
    error_codes: Object.fromEntries(
      [...new Set(errors.map((sample) => sample.code))]
        .sort()
        .map((code) => [code, errors.filter((sample) => sample.code === code).length]),
    ),
    all_latency: latency(samples.map((sample) => sample.ms)),
    successful_latency: latency(successful.map((sample) => sample.ms)),
    by_operation: byOperation,
  };
}
