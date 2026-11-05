// Latency notices name the measured boundary and the evidence behind a reference.
import { type Copy, capital, count, duration } from './mail-words';

export const LATENCY_COPY: Copy[] = [
  {
    signals: ['page_response_p95_ms'],
    title: () => 'Page response-ready time rose',
    means: (f) =>
      `Estimated p95: ${duration(count(f, 'page_response_p95_ms'))}; reference median ${duration(f.baseline ?? 0)}. Excludes background work and body transfer.`,
    reason: true,
    first: 'Inspect timings for this request class and compare upstream calls.',
  },
  {
    signals: ['page_execution_p95_ms'],
    title: () => 'Page execution lifetime rose',
    means: (f) =>
      `Estimated p95: ${duration(count(f, 'page_execution_p95_ms'))}; reference median ${duration(f.baseline ?? 0)}. Includes I/O and background work; separate from response timing.`,
    reason: true,
    first: 'Inspect timings for this request class and compare upstream calls.',
  },
  {
    signals: ['api_response_p95_ms'],
    title: () => 'API response-ready time rose',
    means: (f) =>
      `Estimated p95: ${duration(count(f, 'api_response_p95_ms'))}; reference median ${duration(f.baseline ?? 0)}. Excludes background work and body transfer.`,
    reason: true,
    first: 'Inspect timings for this request class and compare upstream calls.',
  },
  {
    signals: ['api_execution_p95_ms'],
    title: () => 'API execution lifetime rose',
    means: (f) =>
      `Estimated p95: ${duration(count(f, 'api_execution_p95_ms'))}; reference median ${duration(f.baseline ?? 0)}. Includes I/O and background work; separate from response timing.`,
    reason: true,
    first: 'Inspect timings for this request class and compare upstream calls.',
  },
  {
    signals: ['p95_execution_ms'],
    title: (f) => `${capital(f.word)} invocation lifetime rose`,
    means: (f) =>
      `Estimated p95: ${duration(count(f, 'p95_execution_ms'))}; reference median ${duration(f.baseline ?? 0)}. Includes I/O and background work.`,
    reason: true,
    first: 'Inspect invocation timings for this component and upstream calls.',
  },
  {
    signals: ['p95_wall_ms'],
    title: (f) => `${capital(f.word)} execution time rose`,
    means: (f) =>
      `Estimated 95th percentile: ${duration(count(f, 'p95_wall_ms'))}${f.baseline ? `; usual estimate ${duration(f.baseline)}` : ''}. Includes background work.`,
    first: "Inspect request timings and upstream calls in this Worker's logs.",
  },
];
