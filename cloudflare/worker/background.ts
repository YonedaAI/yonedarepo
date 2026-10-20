// Work a request may finish after its response: queue sends whose loss the platform
// recovers anyway (a stale drain request is resent; pending work shows in status). The
// entrypoint lends the request's waitUntil; without one (tests, jobs) the work is awaited.
import { AsyncLocalStorage } from 'node:async_hooks';

const lent = new AsyncLocalStorage<(work: Promise<unknown>) => void>();

export function withWaitUntil<T>(waitUntil: (work: Promise<unknown>) => void, run: () => T) {
  return lent.run(waitUntil, run);
}

/** Runs `work` after the response if the request lent its waitUntil; returns whether it
 * did (otherwise the caller awaits `work` itself). */
export function deferred(work: () => Promise<unknown>) {
  const waitUntil = lent.getStore();
  if (!waitUntil) return false;
  waitUntil(work().catch((e) => console.warn(`deferred work failed: ${e?.message ?? e}`)));
  return true;
}
