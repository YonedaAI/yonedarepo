// Rust compute ops over a repository's objects (search indexing, blame, symbols, review
// classes): the op asks for trees and files by id and the adapter supplies them, bundled
// ones in a few ranged reads, a bounded wave at a time.
import { RANGE, readBundled, WIDE_GAP } from './repo-bundles';
import { compute } from './repo-compute';
import { blobWaves, inWaves } from './repo-object-waves';
import { type CachedObject, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';

/**
 * Runs a Rust compute op that walks trees and reads blobs, supplying both on request, a
 * bounded wave at a time. Blob bytes beyond `maxBytes` refuse with TOO_LARGE: every
 * supplied object goes into one compute call, and Wasm memory never shrinks once grown.
 * `sizes` (`{id: bytes}`) tells the op what the caller knows of file sizes.
 */
export async function withObjects(
  ctx: RepoContext,
  input: Json,
  known: CachedObject[] = [],
  maxBytes = Number.POSITIVE_INFINITY,
  sizes?: Json,
) {
  const objects = await ctx.objects();
  const trees: Json = {};
  const blobs: Json = {};
  let bytes = 0;
  // Objects the caller already holds (a commit being built) are only supplied on request.
  const held = new Map(known.map((o) => [o.id, o]));
  const tree = async (id: string) => {
    const object = held.get(id);
    trees[id] = object?.kind === 'tree' ? object.entries : await objects.tree(id);
  };
  const supply = (id: string, data_b64: string) => {
    bytes += (data_b64.length * 3) / 4;
    if (bytes > maxBytes)
      throw new ApiError('TOO_LARGE', `More than ${maxBytes} bytes of files to read`);
    blobs[id] = data_b64;
  };
  for (let round = 0; round <= 256; round++) {
    const result = compute({ ...input, trees, blobs, ...(sizes ? { sizes } : {}) });
    if (result.need_trees) {
      const need = (result.need_trees as string[]).filter((id) => !held.has(id));
      Object.assign(trees, await bundledTrees(objects, need));
      await inWaves(
        (result.need_trees as string[]).filter((id) => !(id in trees)),
        tree,
      );
    } else if (result.need_blobs) {
      const read: string[] = [];
      for (const id of result.need_blobs as string[]) {
        const object = held.get(id);
        if (object?.kind === 'blob') supply(id, object.data_b64);
        else read.push(id);
      }
      for await (const wave of blobWaves(objects, read))
        for (const [id, data] of wave) supply(id, toBase64(data));
    } else return result;
  }
  throw new ApiError('INVALID_INPUT', 'Too many object rounds');
}

/** Of trees `ids`, the entries of those a repository's bundles hold that this isolate has
 * not parsed yet, in a few ranged reads (a cold isolate otherwise walks the read tiers
 * once per directory). Each is checked against its id; the rest are left out. */
async function bundledTrees(objects: RepoObjects, ids: string[]) {
  const found: Json = {};
  const unread = ids.filter((id) => !objects.remembered(id));
  const bundled = await readBundled(
    objects.env,
    objects.repo,
    unread.map((id) => ({ id, kind: 'tree' })),
    RANGE,
    { gap: WIDE_GAP, copy: true },
  );
  if (bundled.size === 0) return found;
  const raw = [...bundled].map(([id, data]) => ({ id, kind: 'tree', data_b64: toBase64(data) }));
  for (const tree of compute({ op: 'parse_objects', objects: raw }).objects as Json[])
    if (bundled.has(tree.id)) found[tree.id] = tree.entries;
  objects.remember(found);
  return found;
}
