// REGION_HINT_TEST (docs/global-scale-plan.md, latency matrix): a fresh test repository whose
// Durable Objects start in a chosen region, and an owner's read of where they landed. Off, a
// create ignores `region_hint` and `GET /repos/<id>/where` answers as any unknown path. On, only
// a new repository named `region-hint-*` can take one: a location hint counts only at an object's
// first `get`, a create's id is always new, and nothing here touches an existing object. No
// request is routed by this: only new object placement receives a hint.
import { hinted } from './cell-env';
import { ApiError, type Credentials, type Json, type RepoContext } from './repo-ops';
import type { Env } from './types';

const HINTS = new Set(['enam', 'weur', 'apac']);
const TEST_NAME = /^region-hint-[a-z0-9-]{1,60}$/;
/** Cloudflare's trace page answers `colo=<code>` for the data center the request left from. */
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
const TRACE_MS = 5_000;

type Placed = { where(keep?: boolean): Promise<string | null> };

export const regionHintTest = (env: Env) => env.REGION_HINT_TEST === 'on';

/** The hint this create asks for, or null: today's create, for every request while off. */
export function regionHint(env: Env, body: Json): string | null {
  if (!regionHintTest(env) || body.region_hint === undefined) return null;
  if (!HINTS.has(body.region_hint))
    throw new ApiError('INVALID_INPUT', 'region_hint must be enam, weur or apac');
  if (typeof body.name !== 'string' || !TEST_NAME.test(body.name))
    throw new ApiError('INVALID_INPUT', 'region_hint is for repositories named region-hint-*');
  return body.region_hint;
}

/**
 * This create's bindings: the objects made for one repository start near `hint`, and its shards
 * start before the answer. The development experiment waits for startup by default;
 * automatic origin fallback keeps the existing deferred warmup. Object pushes stay out.
 */
export function hintedEnv(env: Env, hint: string, eager = true): Env {
  const namespaces: Partial<Env> = { SOURCE_REPOS: hinted(env.SOURCE_REPOS, hint) };
  if (env.COMMIT_SHARDS) namespaces.COMMIT_SHARDS = hinted(env.COMMIT_SHARDS, hint);
  if (env.LAND_COMBINERS) namespaces.LAND_COMBINERS = hinted(env.LAND_COMBINERS, hint);
  return { ...env, ...namespaces, SHARD_START: eager ? 'request' : env.SHARD_START };
}

const combinerNames = (repo: string) => [`${repo}:main`, `${repo}#head`, `${repo}#projector`];
const combiner = (env: Env, name: string) => {
  const namespace = env.LAND_COMBINERS as DurableObjectNamespace;
  return namespace.get(namespace.idFromName(name)) as unknown as Placed;
};

/** Makes the repository's combiners at their hint: a create may not have used them yet. */
export async function placeCombiners(env: Env, repo: string) {
  if (!env.LAND_COMBINERS) return;
  await Promise.all(combinerNames(repo).map((name) => combiner(env, name).where(true)));
}

/** The data center a trace page names. */
export const coloOf = (trace: string) => /^colo=([A-Z]{3})$/m.exec(trace)?.[1] ?? null;

/** A combiner's answer to `where`. `keep` stores a key, so a combiner made here is a stored
 * object: one that held nothing could start elsewhere later. `erase` removes it. */
export async function placedHere(storage: DurableObjectStorage, keep: boolean) {
  if (keep) await storage.put('placed', true);
  return whereHere();
}

/** The data center this code runs in, or null: never a guess. */
export async function whereHere() {
  const answer = await fetch(TRACE, { signal: AbortSignal.timeout(TRACE_MS) }).catch(() => null);
  return answer?.ok ? coloOf(await answer.text()) : null;
}

async function whereObject(stub: () => DurableObjectStub, url: string) {
  const answer = await stub()
    .fetch(url, { method: 'POST', body: '{}' })
    .catch(() => null);
  return answer?.ok ? coloOf(await answer.text()) : null;
}

/** `GET /repos/<id>/where`: where this code, each of this repository's objects and the asker's
 * account authority run. */
export async function whereRepository(ctx: RepoContext, auth: Credentials): Promise<Json> {
  // Owner only, and a deleted repository answers as one (`repo_storage` refuses the rest).
  await ctx.call({ op: 'repo_storage' });
  const { env, repo } = ctx;
  const shards = env.COMMIT_SHARDS;
  const stub = () => env.SOURCE_REPOS.get(env.SOURCE_REPOS.idFromName(repo));
  const account =
    '_session' in auth ? auth._session.workspace : '_pat' in auth && auth._pat.workspace;
  const owned = account ? env.WORKSPACES.idFromName(`account:${account}`) : null;
  const [worker, authority, shard, combiners, own] = await Promise.all([
    whereHere(),
    whereObject(stub, 'https://source-repository/where'),
    shards
      ? whereObject(() => shards.get(shards.idFromName(`${repo}:0`)), 'https://commit-shard/where')
      : null,
    Promise.all(
      combinerNames(repo).map((name) =>
        env.LAND_COMBINERS
          ? combiner(env, name)
              .where()
              .catch(() => null)
          : null,
      ),
    ),
    owned ? whereObject(() => env.WORKSPACES.get(owned), 'http://workspace/where') : null,
  ]);
  const [main, head, projector] = combiners;
  return { worker, authority, shard, combiner: main, head, projector, account: own };
}
