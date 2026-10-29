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

/** `deferred` bound to the request running now, for work begun later outside its context
 * (a response stream's callbacks). */
export function deferrer(): (work: () => Promise<unknown>) => boolean {
  const waitUntil = lent.getStore();
  return (work) => {
    if (!waitUntil) return false;
    waitUntil(work().catch((e) => console.warn(`deferred work failed: ${e?.message ?? e}`)));
    return true;
  };
}

/** `work` after the response when the request lent its waitUntil, else now: the returned
 * promise is what the answer must wait for (nothing, when deferred). */
export function afterAnswer(work: () => Promise<unknown>): Promise<unknown> {
  return deferred(work) ? Promise.resolve() : work();
}
