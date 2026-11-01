// Git reads through a brief overload. Stock Git retries nothing: `git clone` stops at the
// first 503, and of a 503 on a POST it prints only "RPC failed; HTTP 503" and "expected
// 'packfile'" (it drops the body of any POST answered 300 or above; Git 2.54, checked in
// tests/runtime/git-refusals.test.mjs). So the Worker waits out what it can before the first
// byte, and when it cannot, says so in the one form Git prints.
//
// Budget of one read (`info/refs` of either service, `git-upload-pack`):
//   success       no added wait or call, and no switch: the POST body was always held whole.
//   attempts      3 retries at most, shared by the request's steps (credentials, then the
//                 read from its access check on).
//   added wait    3 s at most in all: 250, 750 and 2,000 ms, each less up to a quarter of
//                 jitter so readers that failed together do not return together.
//   window        no retry starts 20 s or more into the request: a walk that failed late would
//                 spend its subrequests (50,000 a request) and CPU a second time.
//   bytes         an attempt ends when it has a Response, before the first byte of the pack
//                 goes out; a failure after that is the pack stream's (side-band 3), never
//                 retried here.
//   load          at most 4x one read's calls under overload, spread by the waits.
// Only `OVERLOADED` failures count (`failureCode`), and only reads: a push's body is not held,
// and its write may have applied, so a push is retried only at its access check.
import { failureCode, RETRY_AFTER_SECONDS } from './durable';
import { errLine } from './repo-git-upload';
import { record } from './repo-timing';

/** Waits before each retry and the window retries start in, in ms (mutable only so tests can
 * shorten them). */
export const READ_RETRY = { waits: [250, 750, 2_000], window: 20_000 };

/** What a person sees when the retries run out. */
export const BUSY = 'The repository is busy right now; try again in a few seconds';

/** Runs a request's steps, each until it answers or fails otherwise, within the one budget
 * above; a step past it throws the failure. */
export function retrier(repo: string, service: string) {
  const started = Date.now();
  let tries = 0;
  return async <T>(attempt: () => Promise<T>) => {
    for (;;) {
      try {
        return await attempt();
      } catch (e: any) {
        if (failureCode(e) !== 'OVERLOADED') throw e;
        const wait = READ_RETRY.waits[tries];
        const elapsed_ms = Date.now() - started;
        const retrying = wait !== undefined && elapsed_ms < READ_RETRY.window;
        console.warn(
          JSON.stringify({
            event: 'git.overloaded',
            repo,
            service,
            tries,
            elapsed_ms,
            retrying,
            error: String(e?.message ?? e).slice(0, 300),
          }),
        );
        if (!retrying) throw e;
        tries++;
        const ms = wait * (0.75 + Math.random() / 4);
        await new Promise((resolve) => setTimeout(resolve, ms));
        record('git.retry', ms);
      }
    }
  };
}

/** An upload-pack POST that could not be served: an ERR line, the one thing Git prints from a
 * POST (`fatal: remote error: OVERLOADED: ...`). HTTP 200, so that it does: `Retry-After` stays
 * for clients that read it, and the failure is in the log (`git.overloaded`). */
export function busyLine() {
  const line = errLine(new Uint8Array(), { code: 'OVERLOADED', message: BUSY });
  line.headers.set('retry-after', String(RETRY_AFTER_SECONDS));
  return line;
}
