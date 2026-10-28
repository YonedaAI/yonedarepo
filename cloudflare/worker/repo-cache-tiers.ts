// The two cache tiers in front of a repository's object store (repo-objects): the Cache
// API (per colo; it stores nothing on workers.dev) and R2 (shared). Keys carry the
// repository so cached bytes are only reachable through that repository's auth.
import { timed } from './repo-timing';
import type { Env } from './types';

type ObjectKind = 'tree' | 'blob' | 'commit';
const EDGE_ORIGIN = 'https://objects.yoneda.internal';
/** How long a read waits for the edge before asking R2. An edge hit answers in
 * milliseconds; hosted burst read-backs (2026-10-28) saw Cache API calls of 24-33 s. */
const EDGE_WAIT_MS = 500;
/** How long a read waits for the edge alone before asking R2 as well (the first copy
 * found answers). Hosted burst read-backs (2026-10-28, bf7566e): 18 of the 19 edge lookups
 * in the 15 slowest reads ran into EDGE_WAIT_MS, on objects R2 held. */
const EDGE_HEDGE_MS = 50;

const edgeKey = (repo: string, id: string) => new Request(`${EDGE_ORIGIN}/${repo}/${id}`);

export async function edgePut(
  repo: string,
  id: string,
  kind: ObjectKind,
  body: Uint8Array | string,
) {
  try {
    await caches.default.put(
      edgeKey(repo, id),
      new Response(body, {
        headers: { 'cache-control': 'public, max-age=31536000, immutable', 'x-kind': kind },
      }),
    );
  } catch {
    // The edge tier is an optimization; R2 remains authoritative for cached objects.
  }
}

/** Resolves to `value` after `ms`; `stop` clears the timer. */
function after<T>(ms: number, value: T) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<T>((done) => {
    timer = setTimeout(() => done(value), ms);
  });
  return { late, stop: () => clearTimeout(timer) };
}

/** The edge copy of `id`, or null on a miss, a failure or a lookup slower than
 * EDGE_WAIT_MS (the edge tier is an optimization: R2 answers instead). */
async function edgeHit(repo: string, id: string, kind: ObjectKind): Promise<Uint8Array | null> {
  const { late, stop } = after(EDGE_WAIT_MS, null);
  const lookup = caches.default
    .match(edgeKey(repo, id))
    .then(async (hit) =>
      hit && hit.headers.get('x-kind') === kind ? new Uint8Array(await hit.arrayBuffer()) : null,
    )
    .catch(() => null);
  return Promise.race([lookup, late]).finally(stop);
}

async function r2Hit(env: Env, key: string, kind: ObjectKind): Promise<Uint8Array | null> {
  const cached = await env.OBJECTS.get(key);
  return cached && (cached.customMetadata?.kind ?? kind) === kind
    ? new Uint8Array(await cached.arrayBuffer())
    : null;
}

type Copy = { bytes: Uint8Array | null; tier: 'edge' | 'r2' };

/** The edge's copy of `id`, else R2's (under `key`), or null. R2 is asked once the edge
 * misses or has not answered within EDGE_HEDGE_MS; then the first copy found answers, and a
 * miss in one waits for the other. `read.edge` is the wait on the edge alone, `read.r2`
 * the rest. */
export async function cachedCopy(
  env: Env,
  repo: string,
  key: string,
  id: string,
  kind: ObjectKind,
) {
  const edge = edgeHit(repo, id, kind);
  const hedge = after(EDGE_HEDGE_MS, 'hedge' as const);
  const first = await timed('read.edge', () => Promise.race([edge, hedge.late])).finally(
    hedge.stop,
  );
  if (first instanceof Uint8Array) return { bytes: first, tier: 'edge' as const };
  const r2 = r2Hit(env, key, kind);
  // Once the edge answered, an R2 failure is nobody's to handle.
  r2.catch(() => {});
  const copy = await timed('read.r2', async (): Promise<Copy> => {
    if (first === null) return { bytes: await r2, tier: 'r2' };
    const both: Promise<Copy>[] = [
      edge.then((bytes) => ({ bytes, tier: 'edge' })),
      r2.then((bytes) => ({ bytes, tier: 'r2' })),
    ];
    const won = await Promise.race(both);
    return won.bytes ? won : ((await Promise.all(both)).find((c) => c.bytes) ?? won);
  });
  return copy.bytes ? { bytes: copy.bytes, tier: copy.tier } : null;
}
