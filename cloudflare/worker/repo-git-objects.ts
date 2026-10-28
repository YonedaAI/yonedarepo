// Object reads for Git over HTTPS: exact Git content for packs and trees for the walks
// that verify a push or enumerate a fetch, from the store of record first (a push's
// bundles in a few ranged reads, then one R2 object per key).
import {
  fromBundles,
  HEADER,
  type Location,
  locate,
  RANGE,
  readLocated,
  type Wanted,
  WIDE_GAP,
} from './repo-bundles';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import type { Json } from './repo-ops';

/** Objects outside bundles read at a time, one R2 object each. */
const READS = 32;
/** Groups read while the one before them is written into the pack. */
const READ_AHEAD = 2;
/** Tree bytes a walk keeps from the ranges it read beyond the trees it asked for. */
const SEEN_BYTES = 32 * 1024 * 1024;

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

/** Bundle order: by bundle and offset, objects outside bundles last (as listed). */
const byPlace = (a?: Location, b?: Location) => {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a.bundle === b.bundle ? a.at - b.at : a.bundle < b.bundle ? -1 : 1;
};

/**
 * The exact content of `wanted` (`null` where no tier holds one), in groups of bounded
 * size: bundled objects in bundle order, each group one ranged read of at most about
 * `RANGE` bytes (bridging gaps up to `WIDE_GAP`), read `READ_AHEAD` groups ahead; then the
 * rest `READS` at a time through `rawObject`. A pushed history's pack thus reads each
 * bundle about once, not once per object it lists in commit order.
 */
export async function* rawObjects(objects: RepoObjects, wanted: Wanted[]) {
  const where = await locate(objects.env, objects.repo, wanted);
  const order = [...wanted].sort((a, b) => byPlace(where.get(a.id), where.get(b.id)));
  const groups: Wanted[][] = [];
  for (let start = 0; start < order.length; ) {
    let end = start;
    let bytes = 0;
    let single = 0;
    let last: Location | undefined;
    for (; end < order.length; end++) {
      const l = where.get(order[end].id);
      if (!l) {
        if (single++ >= READS) break;
        continue;
      }
      // What it adds to the group's read: its frame, and any gap bridged to reach it.
      const after = last && last.bundle === l.bundle ? last.at + last.size : undefined;
      const adds =
        after !== undefined && l.at - HEADER - after <= WIDE_GAP
          ? Math.max(0, l.at + l.size - after)
          : HEADER + l.size;
      if (end > start && bytes + adds > RANGE) break;
      bytes += adds;
      last = l;
    }
    groups.push(order.slice(start, end));
    start = end;
  }
  const read = async (group: Wanted[]) => {
    const bundled = await readLocated(
      objects.env,
      objects.repo,
      group.flatMap((w) => where.get(w.id) ?? []),
      RANGE,
      { gap: WIDE_GAP },
    );
    const rest = await Promise.all(
      group.map((w) => (bundled.has(w.id) ? null : rawObject(objects, w.id, w.kind))),
    );
    return group.map((w, k) => ({ ...w, data: bundled.get(w.id) ?? rest[k] }));
  };
  const reading: ReturnType<typeof read>[] = [];
  for (let next = 0; next < groups.length || reading.length > 0; ) {
    while (next < groups.length && reading.length <= READ_AHEAD) {
      const pending = read(groups[next++]);
      // Awaited in turn below; a failure ahead of its turn is not unhandled meanwhile.
      pending.catch(() => {});
      reading.push(pending);
    }
    yield await (reading.shift() as ReturnType<typeof read>);
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

/** Trees a walk has read, by id: with each round's trees, every other tree in the ranges
 * read for them (up to `SEEN_BYTES`), where later rounds find most of theirs unread. */
export class SeenTrees {
  readonly trees = new Map<string, Uint8Array>();
  private bytes = 0;
  keep = (kind: string, id: string, data: Uint8Array) => {
    if (kind !== 'tree' || this.trees.has(id) || this.bytes + data.length > SEEN_BYTES) return;
    this.trees.set(id, data.slice());
    this.bytes += data.length;
  };
}

/** Trees `ids` for a walk: those `seen` holds, bundled ones in a few ranged reads (with
 * `seen`, bridging `WIDE_GAP` and keeping every tree they hold), the rest through `read`
 * (`treeFor`), `READS` at a time. */
export async function treesFor(
  objects: RepoObjects,
  ids: string[],
  read = (id: string) => treeFor(objects, id),
  seen?: SeenTrees,
) {
  const known: Json[] = [];
  const asked: string[] = [];
  for (const id of ids) {
    const data = seen?.trees.get(id);
    if (!data) asked.push(id);
    else {
      // The session keeps what it is given.
      known.push({ id, data_b64: toBase64(data) });
      seen?.trees.delete(id);
    }
  }
  const bundled = await fromBundles(
    objects.env,
    objects.repo,
    asked.map((id) => ({ id, kind: 'tree' })),
    RANGE,
    seen ? { gap: WIDE_GAP, copy: true, frame: seen.keep } : {},
  );
  const rest = await inBatches(
    asked.filter((id) => !bundled.has(id)),
    READS,
    read,
  );
  return [
    ...known,
    ...[...bundled].map(([id, data]) => ({ id, data_b64: toBase64(data) })),
    ...rest,
  ];
}

/** Runs `work` over `items`, `width` at a time. */
export async function inBatches<T, R>(items: T[], width: number, work: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width)
    out.push(...(await Promise.all(items.slice(i, i + width).map(work))));
  return out;
}
