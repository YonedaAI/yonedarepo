// Writes of Git objects to R2, each confirmed. A request coalesces its unfinished writes;
// completed writes are remembered per isolate. R2 transient errors remain retried.
import { Flights } from './flights';
import type { CachedObject } from './repo-stores';
import { fromBase64 } from './repo-stores';
import type { Env } from './types';

/** Request-local unfinished writes, and isolate-wide keys already written. */
const writing = new Flights<void>();
const written = new Set<string>();
const WRITTEN_KEYS = 50_000;
const sameObjectBusy = (e: unknown) => /\b10058\b/.test(String((e as Error)?.message ?? e));
/** R2's transient internal (10001) and unavailable (10043) errors: the bytes are written again. */
const internalError = (e: unknown) => /\b100(01|43)\b/.test(String((e as Error)?.message ?? e));

/** A Git object's raw content (no header), as the store of record keeps it. */
export type RawObject = { id: string; kind: 'commit' | 'tree' | 'blob'; data_b64: string };

/**
 * Writes content-addressed objects. Concurrent commits write the same ids (a shared tree,
 * the same blob), and R2 allows one write per key at a time (10058): a write already in
 * flight in this request is joined, a key already written is skipped, and a 10058 counts as written
 * once the object is readable (another writer holds identical bytes), else it is retried.
 * R2's transient internal (10001) and unavailable (10043) errors are retried the same way.
 */
export function putObjects(env: Env, key: (id: string) => string, objects: CachedObject[]) {
  return Promise.all(
    objects.map((o) =>
      writeOnce(env, key(o.id), o.kind, () =>
        o.kind === 'blob' ? fromBase64(o.data_b64) : JSON.stringify(o),
      ),
    ),
  );
}

/** Raw objects into the store of record; each write is confirmed by its stored size. */
export function putRaw(env: Env, key: (id: string) => string, objects: RawObject[]) {
  return Promise.all(
    objects.map((o) => writeOnce(env, key(o.id), o.kind, () => fromBase64(o.data_b64))),
  );
}

/** Raw objects given as bytes (a push's verified objects), written like `putRaw`. */
export function putRawBytes(
  env: Env,
  key: (id: string) => string,
  objects: { id: string; kind: string; data: Uint8Array }[],
) {
  return Promise.all(objects.map((o) => writeOnce(env, key(o.id), o.kind, () => o.data)));
}

/** One object under `key` (a push's bundle), written like `putRaw`. */
export function putBytes(env: Env, key: string, kind: string, body: Uint8Array) {
  return writeOnce(env, key, kind, () => body);
}

function writeOnce(env: Env, key: string, kind: string, body: () => Uint8Array | string) {
  if (written.has(key)) return Promise.resolve();
  return writing.join(key, () => putOnce(env, key, kind, body())).work;
}

async function putOnce(env: Env, key: string, kind: string, body: Uint8Array | string) {
  const size = typeof body === 'string' ? new TextEncoder().encode(body).length : body.length;
  for (let attempt = 0; ; attempt++) {
    try {
      const stored = await env.OBJECTS.put(key, body, { customMetadata: { kind } });
      if (stored && stored.size !== size)
        throw Object.assign(new Error(`R2 stored ${stored.size} of ${size} bytes for ${key}`), {
          code: 'STORE_MISMATCH',
        });
      break;
    } catch (e) {
      const busy = sameObjectBusy(e);
      if ((!busy && !internalError(e)) || attempt >= 3) throw e;
      if (busy && (await env.OBJECTS.head(key))) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  if (written.size >= WRITTEN_KEYS) written.clear();
  written.add(key);
}
