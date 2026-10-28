// The code-search index: one entry per partition (a top-level directory, or the top-level
// files), keyed in R2 by its content, so it is built once and reused by every commit and
// branch holding that subtree. A partition is indexed in chunks of bounded bytes, so no
// directory is ever left out for its size: only a file over the per-file cap (4 MiB) or a
// binary one is listed by path alone, with the reason. Paths are relative to the
// partition; readers pass its prefix, so a renamed directory reuses its index. Segments
// are stored compact (yoneda-core search/stored.rs) and handed to Rust as stored.
import { bundledPlaces } from './repo-bundles';
import { compute } from './repo-compute';
import { withObjects } from './repo-object-compute';
import { fromBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';
import { timed } from './repo-timing';

// `search/v4`: segments are stored compact, not as JSON (under half the bytes for source).
// v3: an index may be several chunk segments, and files up to 4 MiB are indexed. v2
// indexed files up to 1 MiB and skipped a partition over 8 MiB whole.
const segmentKey = (repo: string, key: string) => `derived/v1/${repo}/search/v4/${key}`;
/** A stored segment starts with these bytes; a chunked index's count is JSON. */
const SEGMENT_MAGIC = 'YSG1';

/** File bytes one chunk's build reads at most (all go into one compute call). */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** Files one chunk lists at most (sizes not known up front count once read). */
const CHUNK_FILES = 500;
/** Must match yoneda-core's MAX_INDEXED_BYTES: larger files are not read. */
const MAX_INDEXED_BYTES = 4 * 1024 * 1024;
/** Stored indexes read at a time. */
const SEGMENT_READS = 8;
/** A size no file has: an index lists the file by path, unread. */
const TOO_LARGE = Number.MAX_SAFE_INTEGER;

/** A partition's index: its one segment, or how many chunk segments it has; `refused` when
 * the directory lists more files than an index may hold. */
export type PartitionIndex = {
  partition: Json;
  segment?: Uint8Array;
  chunks: number;
  refused?: string;
};

const chunkKey = (key: string, i: number) => `${key}/${i}`;

/** A stored segment, or a chunked index's `{ chunks }`. */
async function stored(ctx: RepoContext, key: string): Promise<Uint8Array | Json | null> {
  const bytes = await timed('search.segment', async () => {
    const object = await ctx.env.OBJECTS.get(segmentKey(ctx.repo, key));
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  });
  if (!bytes) return null;
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === SEGMENT_MAGIC) return bytes;
  return JSON.parse(new TextDecoder().decode(bytes));
}

const isSegment = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/** `files` in chunks of at most CHUNK_FILES and (as far as sizes are known) CHUNK_BYTES;
 * a file over the cap costs nothing, as it is not read. */
function chunked(files: Json[], sizes: Json) {
  const chunks: Json[][] = [];
  let chunk: Json[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Number(sizes[file.id] ?? 0);
    const cost = size > MAX_INDEXED_BYTES ? 0 : size;
    if (chunk.length > 0 && (chunk.length >= CHUNK_FILES || bytes + cost > CHUNK_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(file);
    bytes += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Segments of `files`: one, or (when their content outgrows CHUNK_BYTES, as files of
 * unknown size can) those of each half; a single file over the budget is listed unread. */
async function segmentsOf(ctx: RepoContext, files: Json[], sizes: Json): Promise<Uint8Array[]> {
  try {
    const { segment_b64 } = await withObjects(
      ctx,
      { op: 'index_files', files },
      [],
      CHUNK_BYTES,
      sizes,
    );
    return [fromBase64(segment_b64)];
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'TOO_LARGE')) throw e;
    if (files.length === 1) {
      sizes[files[0].id] = TOO_LARGE;
      return segmentsOf(ctx, files, sizes);
    }
    const half = Math.ceil(files.length / 2);
    return [
      ...(await segmentsOf(ctx, files.slice(0, half), sizes)),
      ...(await segmentsOf(ctx, files.slice(half), sizes)),
    ];
  }
}

/** Builds and stores partition `p`'s index, a chunk at a time: one segment is stored under
 * the partition's key; several under chunk keys, then their count under the partition's
 * key (last, so a build that dies leaves no index to read). Holds one segment at most. */
async function build(ctx: RepoContext, p: Json): Promise<PartitionIndex> {
  const listed: Json = await withObjects(ctx, {
    op: 'partition_files',
    tree: p.tree,
    shallow: p.shallow,
  }).catch((e) => {
    if (e instanceof ApiError && e.code === 'TOO_LARGE') return { refused: e.message };
    throw e;
  });
  if (listed.refused) return { partition: p, chunks: 0, refused: listed.refused };
  const files = listed.files as Json[];
  // Bundled files' sizes, so files too large to index are never read.
  const sizes: Json = {};
  const places = await bundledPlaces(
    await ctx.objects(),
    files.map((f) => String(f.id)),
  );
  for (const [id, place] of places) sizes[id] = place.size;
  const put = (key: string, value: Uint8Array | Json) =>
    ctx.env.OBJECTS.put(
      segmentKey(ctx.repo, key),
      isSegment(value) ? value : JSON.stringify(value),
    );
  let first: Uint8Array | undefined;
  let count = 0;
  for (const chunk of chunked(files, sizes))
    for (const segment of await segmentsOf(ctx, chunk, sizes)) {
      if (count === 0) first = segment;
      else {
        if (count === 1) await put(chunkKey(p.key, 0), first as Uint8Array);
        await put(chunkKey(p.key, count), segment);
      }
      count++;
    }
  if (count <= 1) {
    const segment = first ?? fromBase64(compute({ op: 'index_files', files: [] }).segment_b64);
    await put(p.key, segment);
    return { partition: p, segment, chunks: 1 };
  }
  await put(p.key, { chunks: count });
  return { partition: p, chunks: count };
}

/** Each partition's index for a root tree, building missing ones (one at a time: a build
 * holds a chunk's files). Stored ones are read side by side. */
export async function searchSegments(ctx: RepoContext, root: string) {
  const { partitions } = await timed('search.plan', () =>
    withObjects(ctx, { op: 'search_plan', root }),
  );
  let built = 0;
  const indexes: PartitionIndex[] = [];
  for (let i = 0; i < partitions.length; i += SEGMENT_READS)
    indexes.push(
      ...(await Promise.all(
        (partitions as Json[]).slice(i, i + SEGMENT_READS).map(async (partition) => {
          const value = await stored(ctx, partition.key);
          if (isSegment(value)) return { partition, chunks: 1, segment: value };
          return { partition, chunks: Number(value?.chunks ?? 0) };
        }),
      )),
    );
  for (const [i, index] of indexes.entries()) {
    if (index.chunks > 0) continue;
    indexes[i] = await timed('search.index', () => build(ctx, index.partition));
    built++;
  }
  return { indexes, built };
}

/** The segments of `indexes`, one at a time (a chunked index's are read as needed). */
export async function* segmentsIn(ctx: RepoContext, indexes: PartitionIndex[]) {
  for (const index of indexes) {
    if (index.segment) yield { partition: index.partition, segment: index.segment };
    else
      for (let i = 0; i < index.chunks; i++) {
        const segment = await stored(ctx, chunkKey(index.partition.key, i));
        if (!isSegment(segment)) throw new ApiError('NOT_FOUND', 'A search index chunk is missing');
        yield { partition: index.partition, segment };
      }
  }
}
