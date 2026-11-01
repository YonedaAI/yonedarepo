// Calls into the platform's Durable Objects. A call that fails because the instance was
// reset (a deploy, an eviction) is retried once on a fresh stub, as Cloudflare advises; the
// platform's commands are idempotent (records, adoptions, landings and enqueues answer
// "already" on a repeat), so a call that did run before the reset is safe to repeat.
import { log } from './log';
import { carriedHeaders } from './request-scope';

const RESET = /no longer active|Network connection lost|reset because its code was updated/i;
const OVERLOAD = /overloaded|queued for too long|too many requests queued/i;
/** How a Durable Object's database refuses a write at its size limit (production, workerd). */
const FULL = /Exceeded the maximum database size|database or disk is full|SQLITE_FULL/i;

/** Seconds a client waits before retrying a request the platform was too busy to serve. */
export const RETRY_AFTER_SECONDS = 1;

/** Where a repository's history database refuses new work, in bytes: `databaseSize` as Durable
 * Object SQLite reports it. Cloudflare publishes 10 GB, and the 600 MB above this holds the
 * worst accepted work measured (530 MB, docs/global-scale-plan.md). Internal: never published. */
const STORAGE_GUARD_BYTES = 9_400_000_000;
/** Where a repository's Git objects refuse pushes and new commits: the published size. */
const SIZE_GUARD_BYTES = 10_000_000_000;

/** What a person is told for `REPO_FULL` (yoneda_store::REPO_FULL_MESSAGE says the same). */
export const REPO_FULL_MESSAGE =
  'This repository has reached its activity limit. New commits and Landings are refused; reading, cloning and deleting still work. To keep going, start a new repository or contact support.';

/** The least time between two `repo.full` lines for one repository in this isolate. */
const FULL_LOG_MS = 10 * 60 * 1000;
/** Repositories this isolate remembers reporting; past this it starts over. */
const FULL_LOGS_KEPT = 4096;
const reportedFull = new Map<string, number>();

/**
 * Tells an operator that `repo` refused `operation` for its size. The refusal says so because
 * a full repository stops landing, and with it the job that samples its size.
 */
export function noteFull(repo: string, operation: string, now = Date.now()) {
  const last = reportedFull.get(repo);
  if (last !== undefined && now - last < FULL_LOG_MS) return;
  if (reportedFull.size >= FULL_LOGS_KEPT) reportedFull.clear();
  reportedFull.set(repo, now);
  log.warn('repo.full', { repo, operation });
}

/** `answer` to `operation` on `repo`, having noted a refusal for size. A published head that
 * says full counts: a commit is refused from it in compute and never reaches the authority. */
export function notingFull<T extends Record<string, any>>(
  repo: string,
  operation: string,
  answer: Promise<T>,
) {
  return answer.then(
    (value) => {
      if (value.error?.code === 'REPO_FULL' || (operation === 'repo_head' && value.full === true))
        noteFull(repo, operation);
      return value;
    },
    (e) => {
      if (e?.code === 'REPO_FULL') noteFull(repo, operation);
      throw e;
    },
  );
}

/** A guard's limit: `on` for `standard`, or a byte count, for tests. */
function limitOf(guard: string | undefined, standard: number) {
  if (guard === 'on') return standard;
  const bytes = Number(guard);
  return guard && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * What a command to a repository carries for the authority to refuse work at its limits
 * (repo_store::capacity): `REPO_STORAGE_GUARD` for its history database, `REPO_SIZE_GUARD`
 * for its Git objects. Neither is set unless its variable is on, and the variables are never
 * client input.
 */
export function storageGuard(env: { REPO_STORAGE_GUARD?: string; REPO_SIZE_GUARD?: string }) {
  const history = limitOf(env.REPO_STORAGE_GUARD, STORAGE_GUARD_BYTES);
  const size = limitOf(env.REPO_SIZE_GUARD, SIZE_GUARD_BYTES);
  return {
    ...(history && { _storage_guard: history }),
    ...(size && { _size_guard: size }),
  };
}

/**
 * A failure that says nothing about the request: a Durable Object overloaded, reset or
 * briefly unreachable (Cloudflare marks these `.overloaded` or `.retryable`). The same
 * request can succeed later. Platform answers carry a string `code` and never count.
 */
export function transient(e: any): boolean {
  if (typeof e?.code === 'string') return false;
  const message = String(e?.message ?? e);
  return (
    e?.overloaded === true || e?.retryable === true || OVERLOAD.test(message) || RESET.test(message)
  );
}

/** The API code of a failure: the platform's own, OVERLOADED when transient, else INTERNAL
 * (an unexpected failure is the platform's fault, never the caller's input). */
export function failureCode(e: any): string {
  if (typeof e?.code === 'string' && e.code) return e.code;
  return transient(e) ? 'OVERLOADED' : 'INTERNAL';
}

/**
 * `call`, or a rejection (no `code`: unexpected, so `failureCode` says INTERNAL) once `ms`
 * pass. The call itself cannot be cancelled and may still take effect later.
 */
export function bounded<T>(ms: number, call: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
    call.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** `run`, bounded to `ms`, once more if that fails: only for what is safe to repeat, also
 * after a first attempt that lands late (`run` is told it is the retry). */
export function boundedRetry<T>(ms: number, run: (retry: boolean) => Promise<T>): Promise<T> {
  return bounded(ms, run(false)).catch(() => bounded(ms, run(true)));
}

/** `Symbol.dispose` (workerd has it; this project's TypeScript lib does not declare it). */
const DISPOSE = (Symbol as { dispose?: symbol }).dispose;

/**
 * The value of an RPC call (a Durable Object or binding method), with its disposer run once
 * `use` is done with it. Every object an RPC answers carries one, and a result left to the
 * garbage collector holds the call's resources until then (workerd: "An RPC result was not
 * disposed properly"). Plain data in the value stays usable after disposal.
 */
export async function rpcValue<T, R = T>(
  call: Promise<T>,
  use: (value: T) => R | Promise<R> = (value) => value as unknown as R,
): Promise<R> {
  const value = await call;
  try {
    return await use(value);
  } finally {
    const dispose = DISPOSE && (value as Record<symbol, unknown> | null)?.[DISPOSE];
    if (typeof dispose === 'function') dispose.call(value);
  }
}

export async function durableJson<T = Record<string, any>>(
  stub: () => DurableObjectStub,
  url: string,
  body: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await stub().fetch(url, { method: 'POST', body, headers: carriedHeaders() });
      return await response.json<T>();
    } catch (e: any) {
      // Thrown out of the call with the instance reset, not answered: the object cannot catch
      // it (a write past the limit breaks the instance). The same write fails again.
      if (FULL.test(String(e?.message ?? e)))
        throw Object.assign(new Error(REPO_FULL_MESSAGE), { code: 'REPO_FULL' });
      if (attempt > 0 || !(e?.retryable === true || RESET.test(String(e?.message ?? e)))) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
}
