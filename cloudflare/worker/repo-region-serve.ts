// REGION_HINT_TEST: the platform's own request path, run inside a Durable Object in a chosen
// region (docs/global-scale-plan.md, same-region test). A Worker pinned to one place can't show
// what a region would give, but a Durable Object's code runs where the object landed, and it is
// the platform's code. So this runs real routes in Europe or Asia with no cell, no new class and
// no routing change: only a client holding the bench key reaches it, through a binding.
//
// Every binding that can leave the region is wrapped here, and each call lands in Server-Timing
// as `hop.<name>`, so an answer lists what it reached. What a combiner or a repository object
// calls for itself runs where that object runs, and isn't listed.
import { withWaitUntil } from './background';
import { platformFetch } from './platform-routes';
import { timed, withTimings } from './repo-timing';
import type { Env } from './types';

type AnyFunction = (...args: any[]) => any;

/** `target` with `wrap` applied to each method it has. */
function proxied<T extends object>(
  target: T,
  wrap: (key: string, call: AnyFunction) => AnyFunction,
) {
  return new Proxy(target, {
    get(t, key) {
      const value = (t as any)[key];
      if (typeof value !== 'function') return value;
      const bound = value.bind(t);
      return typeof key === 'string' ? wrap(key, bound) : bound;
    },
  });
}

/** `target`, with calls to `names` timed as `phase`. */
const hops = <T extends object>(target: T, phase: string, names: string[]) =>
  proxied(target, (key, call) =>
    names.includes(key) ? (...args) => timed(phase, async () => call(...args)) : call,
  );

/** A statement of `INDEX`: every run of it is a hop. */
function statement(real: any, originals: WeakMap<object, object>): any {
  const wrapped = proxied(real, (key, call) => {
    if (key === 'bind') return (...args) => statement(call(...args), originals);
    return ['first', 'run', 'all', 'raw'].includes(key)
      ? (...args) => timed('hop.d1', async () => call(...args))
      : call;
  });
  originals.set(wrapped, real);
  return wrapped;
}

function database(real: D1Database) {
  const originals = new WeakMap<object, object>();
  return proxied(real, (key, call) => {
    if (key === 'prepare') return (sql: string) => statement(call(sql), originals);
    if (key === 'batch')
      return (list: object[]) =>
        timed('hop.d1', async () => call(list.map((s) => originals.get(s) ?? s)));
    return call;
  });
}

/** A namespace whose stubs time every call: `fetch` and RPC methods alike. */
const objects = (real: DurableObjectNamespace, phase: string) =>
  proxied(real, (key, call) => {
    if (key !== 'get') return call;
    return (...args) =>
      proxied(call(...args), (method, stubCall) =>
        method === 'then' ? stubCall : (...rest) => timed(phase, async () => stubCall(...rest)),
      );
  });

function artifacts(real: NonNullable<Env['ARTIFACTS']>) {
  const reads = ['readBlob', 'readTree', 'readCommit', 'info', 'createToken', 'revokeToken'];
  return proxied(real, (key, call) => {
    if (key === 'create') return (...args) => timed('hop.artifacts', async () => call(...args));
    if (key !== 'get') return call;
    return async (...args) =>
      hops(await timed('hop.artifacts', async () => call(...args)), 'hop.artifacts', reads);
  });
}

/** `env` with every binding that can leave the region counted. */
export function meteredEnv(env: Env): Env {
  return {
    ...env,
    OBJECTS: hops(env.OBJECTS, 'hop.r2', ['get', 'put', 'head', 'list', 'delete']),
    INDEX: database(env.INDEX),
    WORKSPACES: objects(env.WORKSPACES, 'hop.authority'),
    ...(env.COMMIT_SHARDS && { COMMIT_SHARDS: objects(env.COMMIT_SHARDS, 'hop.shard') }),
    ...(env.LAND_COMBINERS && { LAND_COMBINERS: objects(env.LAND_COMBINERS, 'hop.combiner') }),
    PLATFORM_QUEUE: hops(env.PLATFORM_QUEUE, 'hop.queue', ['send', 'sendBatch']),
    ...(env.PLATFORM_CHECKS && {
      PLATFORM_CHECKS: hops(env.PLATFORM_CHECKS, 'hop.queue', ['send', 'sendBatch']),
    }),
    ...(env.ARTIFACTS && { ARTIFACTS: artifacts(env.ARTIFACTS) }),
    ...(env.AUTH_LIMITER && { AUTH_LIMITER: hops(env.AUTH_LIMITER, 'hop.limiter', ['limit']) }),
  };
}

/** Answers `req` from here, with the phases of a route that keeps none of its own. */
export async function serveHere(
  req: Request,
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
) {
  const near = meteredEnv(env);
  const { value, header } = await withTimings(() =>
    withWaitUntil(waitUntil, () => platformFetch(req, near)),
  );
  if (value.headers.has('server-timing')) return value;
  const answer = new Response(value.body, value);
  answer.headers.set('server-timing', header);
  return answer;
}

/** A combiner's `fetch`: only with REGION_HINT_TEST on, for the instances named
 * `region-serve:<hint>`. A stored key keeps the instance where it started. */
export async function servedHere(ctx: DurableObjectState, env: Env, request: Request) {
  if (env.REGION_HINT_TEST !== 'on') return new Response('Not found', { status: 404 });
  await ctx.storage.put('placed', true);
  return serveHere(request, env, (work) => ctx.waitUntil(work));
}
