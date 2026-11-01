// Work a request may finish after its response: queue sends whose loss the platform
// recovers anyway (a stale drain request is resent; pending work shows in status). The
// entrypoint lends the request's waitUntil; without one (tests, jobs) the work is awaited.
import { log } from './log';
import { currentScope, inScope } from './request-scope';

export function withWaitUntil<T>(waitUntil: (work: Promise<unknown>) => void, run: () => T) {
  return inScope({ waitUntil }, run);
}

const settled = (e: unknown) => log.warn('deferred.failed', { error: e });

/** Runs `work` after the response if the request lent its waitUntil; returns whether it
 * did (otherwise the caller awaits `work` itself). */
export function deferred(work: () => Promise<unknown>) {
  const waitUntil = currentScope()?.waitUntil;
  if (!waitUntil) return false;
  waitUntil(work().catch(settled));
  return true;
}

/** `deferred` bound to the request running now, for work begun later outside its context
 * (a response stream's callbacks). */
export function deferrer(): (work: () => Promise<unknown>) => boolean {
  const waitUntil = currentScope()?.waitUntil;
  return (work) => {
    if (!waitUntil) return false;
    waitUntil(work().catch(settled));
    return true;
  };
}

/** `work` after the response when the request lent its waitUntil, else now: the returned
 * promise is what the answer must wait for (nothing, when deferred). */
export function afterAnswer(work: () => Promise<unknown>): Promise<unknown> {
  return deferred(work) ? Promise.resolve() : work();
}
