// Object reads for Git over HTTPS: exact Git content for packs and trees for the walks
// that verify a push or enumerate a fetch, from the store of record first (a push's
// bundles in a few ranged reads, then one R2 object per key).
import { fromBundles, locate, RANGE, readLocated, type Wanted } from './repo-bundles';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import type { Json } from './repo-ops';

/** Objects located per authority round trip while a pack streams. */
const WINDOW = 2_000;
/** Objects outside bundles read at a time, one R2 object each. */
const READS = 32;

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

/**
 * The exact content of `wanted`, in order, in groups of bounded size (`null` where no
 * tier holds one): bundled objects by ranged reads of at most about `RANGE` bytes per
 * group, the rest `READS` at a time through `rawObject`.
 */
export async function* rawObjects(objects: RepoObjects, wanted: Wanted[]) {
  for (let i = 0; i < wanted.length; i += WINDOW) {
    const window = wanted.slice(i, i + WINDOW);
    const where = await locate(objects.env, objects.repo, window);
    for (let start = 0; start < window.length; ) {
      let end = start;
      let bytes = 0;
      let single = 0;
      for (; end < window.length; end++) {
        const size = where.get(window[end].id)?.size;
        if (size === undefined ? single++ >= READS : end > start && bytes + size > RANGE) break;
        bytes += size ?? 0;
      }
      const group = window.slice(start, end);
      const bundled = await readLocated(
        objects.env,
        objects.repo,
        group.flatMap((w) => where.get(w.id) ?? []),
      );
      const rest = await Promise.all(
        group.map((w) => (bundled.has(w.id) ? null : rawObject(objects, w.id, w.kind))),
      );
      yield group.map((w, k) => ({ ...w, data: bundled.get(w.id) ?? rest[k] }));
      start = end;
    }
  }
}

/** A repository tree for verification: raw from the store of record, else its entries
 * through the read tiers (Rust checks either against the id). */
export async function treeFor(objects: RepoObjects, id: string): Promise<Json> {
  const stored = await objects.env.OBJECTS.get(objects.rawKey(id));
  if (stored?.customMetadata?.kind === 'tree')
    return { id, data_b64: toBase64(new Uint8Array(await stored.arrayBuffer())) };
  return { id, entries: await objects.tree(id) };
}

/** Trees `ids` for a walk: bundled ones in a few ranged reads, the rest through `read`
 * (`treeFor`), `READS` at a time. */
export async function treesFor(
  objects: RepoObjects,
  ids: string[],
  read = (id: string) => treeFor(objects, id),
) {
  const bundled = await fromBundles(
    objects.env,
    objects.repo,
    ids.map((id) => ({ id, kind: 'tree' })),
  );
  const rest = await inBatches(
    ids.filter((id) => !bundled.has(id)),
    READS,
    read,
  );
  return [...[...bundled].map(([id, data]) => ({ id, data_b64: toBase64(data) })), ...rest];
}

/** Runs `work` over `items`, `width` at a time. */
export async function inBatches<T, R>(items: T[], width: number, work: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width)
    out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return out;
}
