// Object reads for Git over HTTPS: exact Git content for packs and trees for the walks
// that verify a push or enumerate a fetch, from the store of record first.
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import type { Json } from './repo-ops';

/** A Git object's exact content: the store of record (R2), the authority's staged copy,
 * or (blobs only) the object store; `null` when none holds it. */
export async function rawObject(objects: RepoObjects, id: string, kind: string) {
  const stored = await objects.env.OBJECTS.get(objects.rawKey(id));
  if (stored && (stored.customMetadata?.kind ?? kind) === kind)
    return new Uint8Array(await stored.arrayBuffer());
  const [staged] = await objects.raw([{ id, kind }]);
  if (staged?.kind === kind) return fromBase64(staged.data_b64);
  if (kind !== 'blob') return null;
  return objects.blob(id).catch((e) => {
    if (e?.code === 'NOT_FOUND') return null;
    throw e;
  });
}

/** A repository tree for verification: raw from the store of record, else its entries
 * through the read tiers (Rust checks either against the id). */
export async function treeFor(objects: RepoObjects, id: string): Promise<Json> {
  const stored = await objects.env.OBJECTS.get(objects.rawKey(id));
  if (stored?.customMetadata?.kind === 'tree')
    return { id, data_b64: toBase64(new Uint8Array(await stored.arrayBuffer())) };
  return { id, entries: await objects.tree(id) };
}

/** Runs `work` over `items`, `width` at a time. */
export async function inBatches<T, R>(items: T[], width: number, work: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width)
    out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return out;
}
