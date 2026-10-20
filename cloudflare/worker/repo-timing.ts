// Per-request phase timings for the platform write path, returned as a standard
// `Server-Timing` header so a benchmark can see where commit latency goes. Workers clocks
// advance only across I/O, so a phase measures the waits it contains (DO round trips,
// queue waits, store calls), not CPU between them. Phases outside a timed request no-op.
import { AsyncLocalStorage } from 'node:async_hooks';

type Phase = { ms: number; n: number };
const current = new AsyncLocalStorage<Map<string, Phase>>();

/** Adds `ms` (over `n` items) to `phase` in the current request, if one is being timed. */
export function record(phase: string, ms: number, n = 1) {
  const phases = current.getStore();
  if (!phases) return;
  const entry = phases.get(phase) ?? { ms: 0, n: 0 };
  entry.ms += ms;
  entry.n += n;
  phases.set(phase, entry);
}

export async function timed<T>(phase: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    record(phase, performance.now() - started);
  }
}

/** Runs `handle` with a fresh timing scope and renders what it recorded. */
export async function withTimings<T>(handle: () => Promise<T>) {
  const phases = new Map<string, Phase>();
  const value = await current.run(phases, () => timed('total', handle));
  const header = [...phases]
    .map(([name, p]) => `${name};dur=${p.ms.toFixed(1)};desc="${p.n}"`)
    .join(', ');
  return { value, header };
}
