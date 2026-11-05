// What one request (or queue job, or cron) carries through its async work: the waitUntil it
// lends, and the id that names it in every log line. The store exists for every request and
// costs one object; the id is worked out when something asks for it, so a healthy request
// with REQUEST_IDS off never does.
//
// The id is Cloudflare's `cf-ray` where the edge gave one, because a person already sees that
// on an error page and in the response. It is carried by hand from there: the ray survives only
// a service binding that forwards the same Request; a Durable Object call, a queue message, an
// RPC call and a container request all start with no ray of their own (docs/logging.md).
import { AsyncLocalStorage } from 'node:async_hooks';
import { queueDelay } from './queue-timing';
import type { Envelope } from './types';

/** The header that carries the id between Workers, Durable Objects and containers, and back
 * to the client. */
export const REQUEST_ID_HEADER = 'x-request-id';

const RAY = /^[0-9a-f]{16}(-[A-Z0-9]+)?$/i;
const ID = /^[A-Za-z0-9._-]{8,64}$/;

type Waiter = (work: Promise<unknown>) => void;
type Switches = { REQUEST_IDS?: string; BUILD_REVISION?: string };
/** The job in scope; its fields come from a queue message, so none is trusted to exist. */
type Job = Pick<Partial<Envelope>, 'repo_id' | 'job_id' | 'kind' | 'request_id'>;

export type Seed = { env?: Switches; req?: Request; waitUntil?: Waiter; job?: Job };
type Scope = Seed & {
  id?: string;
  /** This request's phases are kept already: one sample a request (repo-span-sample.ts). */
  spansTaken?: boolean;
};

const scopes = new AsyncLocalStorage<Scope>();

export const currentScope = () => scopes.getStore();

export const inScope = <T>(seed: Seed, run: () => T) => scopes.run({ ...seed }, run);

/** `run` in the scope already open, or one of its own (a route called without an entrypoint). */
export const ensureScope = <T>(seed: Seed, run: () => T) =>
  scopes.getStore() ? run() : inScope(seed, run);

function idOf({ req, job }: Scope) {
  if (job) {
    const sent = job.request_id;
    return typeof sent === 'string' && ID.test(sent) ? sent : crypto.randomUUID();
  }
  // Anyone may send either header. The edge overwrites `cf-ray`, so it goes first: a forged
  // x-request-id counts only where no ray arrived, which on a public hostname is never.
  const ray = req?.headers.get('cf-ray');
  if (ray && RAY.test(ray)) return ray;
  const sent = req?.headers.get(REQUEST_ID_HEADER);
  return sent && ID.test(sent) ? sent : crypto.randomUUID();
}

/** This request's or job's id, or undefined outside any scope. */
export function requestId(scope = scopes.getStore()) {
  if (!scope) return undefined;
  scope.id ??= idOf(scope);
  return scope.id;
}

const carrying = (scope: Scope | undefined): scope is Scope => scope?.env?.REQUEST_IDS === 'on';

/** What an outgoing Durable Object, binding or container request adds (REQUEST_IDS). */
export function carriedHeaders(): Record<string, string> | undefined {
  const scope = scopes.getStore();
  return carrying(scope) ? { [REQUEST_ID_HEADER]: requestId(scope) as string } : undefined;
}

/** `req` to forward over a service binding, naming this request (REQUEST_IDS). */
export function carriedRequest(req: Request): Request {
  const headers = carriedHeaders();
  if (!headers) return req;
  const forwarded = new Request(req, { cf: req.cf });
  forwarded.headers.set(REQUEST_ID_HEADER, headers[REQUEST_ID_HEADER]);
  return forwarded;
}

/** `queue`, carrying its deliberate delay and this request's id (REQUEST_IDS). Fields are optional
 * and consumers read fields by name, so old and new messages and Workers mix freely during a
 * deploy; a consumer without an id in its message mints one. */
export function carriedQueue<T extends Queue<Envelope>>(queue: T): T {
  const scope = scopes.getStore();
  const stamp = (body: Envelope, options?: { delaySeconds?: number }) => ({
    ...body,
    queue_delay_ms: queueDelay(options),
    ...(carrying(scope) ? { request_id: requestId(scope) } : {}),
  });
  return {
    send: (body: Envelope, options?: QueueSendOptions) => queue.send(stamp(body, options), options),
    sendBatch: (
      messages: Iterable<MessageSendRequest<Envelope>>,
      options?: QueueSendBatchOptions,
    ) =>
      queue.sendBatch(
        [...messages].map((message) => ({
          ...message,
          body: stamp(message.body, {
            delaySeconds: message.delaySeconds ?? options?.delaySeconds,
          }),
        })),
        options,
      ),
  } as unknown as T;
}

/** `res` with the request's id, for the client (REQUEST_IDS). */
export function withRequestId(res: Response): Response {
  const headers = carriedHeaders();
  if (!headers || res.status === 101) return res;
  const id = headers[REQUEST_ID_HEADER];
  try {
    res.headers.set(REQUEST_ID_HEADER, id);
    return res;
  } catch {
    // Immutable headers (a fetched or redirect response): this copy shares its body.
    const copy = new Response(res.body, res);
    copy.headers.set(REQUEST_ID_HEADER, id);
    return copy;
  }
}

// Neutral per-request phase timings for front and platform adapters, returned as a standard
// `Server-Timing` header so a benchmark can see where commit latency goes. Workers clocks
// advance only across I/O, so a phase measures the waits it contains (DO round trips,
// queue waits, store calls), not CPU between them. Phases outside a timed request no-op.

type Phase = { ms: number; n: number };
export type Phases = Map<string, Phase>;
const timingPhases = new AsyncLocalStorage<Phases>();

/** Adds `ms` (over `n` items) to `phase` in the current request, if one is being timed. */
export function record(phase: string, ms: number, n = 1) {
  const phases = timingPhases.getStore();
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

/** Runs `handle` with a fresh timing scope and renders what it recorded; `phases` is what a
 * caller may keep (repo-span-sample.ts). */
export async function withTimings<T>(handle: () => Promise<T>) {
  const phases: Phases = new Map();
  const value = await timingPhases.run(phases, () => timed('total', handle));
  const header = [...phases]
    .map(([name, p]) => `${name};dur=${p.ms.toFixed(1)};desc="${p.n}"`)
    .join(', ');
  return { value, header, phases };
}
