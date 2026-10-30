// Building a pack (shared by a fetch's answer, repo-git-upload, and the pack-build job,
// repo-pack-jobs): the session counts what the walk named, then the pack is written wave by
// wave as its objects are read from the store of record, in pieces of about `CHUNK` bytes.
import { holdsBundles, type ReadStats, type Wanted } from './repo-bundles';
import {
  enumerate,
  FETCH_READS,
  gather,
  overBudget,
  ReadBudget,
  rawObjects,
  SeenTrees,
  treeFor,
  waves,
} from './repo-git-objects';
import type { UploadSession } from './repo-git-sessions';
import { deflated, isLarge, type LargeBody } from './repo-large-files';
import type { RepoObjects } from './repo-objects';
import { ApiError } from './repo-ops';
import { CHUNK, concat, type PackStats } from './repo-pack-stream';
import { quarantined } from './repo-quarantine-guard';

type Read = Wanted & { data: Uint8Array | LargeBody | null };

/** Commits read while the walk runs, at most (each is held until the pack is written). */
const EARLY_COMMITS = 20_000;
/** Time one pack may take to stream (the clock moves with its reads and the client). */
const PACK_MS = 15 * 60_000;

/** A counted pack: its object count and its pieces (`packChunks`), which close `session`
 * once iterated; `close` closes it when the pieces are never asked for. */
export type Built = {
  count: number;
  chunks: AsyncGenerator<Uint8Array, void, undefined>;
  close: () => void;
};

/** Counts the pack `session` lists (the walk named `commits`, read meanwhile), refusing
 * before any byte one that would read too much one object at a time or carry a withheld
 * blob. Closes `session` when it throws. */
export async function buildPack(
  session: UploadSession,
  objects: RepoObjects,
  commits: string[],
  stats: PackStats,
): Promise<Built> {
  const seen = new SeenTrees(commits.length);
  const budget = new ReadBudget();
  // The commits the walk names are read while their trees are walked.
  const early: Promise<Read[]> =
    commits.length <= EARLY_COMMITS
      ? readWhole(
          objects,
          commits.map((id) => ({ id, kind: 'commit' })),
          stats.reads,
          budget,
        )
      : Promise.resolve([]);
  early.catch(() => {});
  let count = 0;
  try {
    await refuseMirrorOnly(objects, commits);
    const started = performance.now();
    ({ count } = await enumerate(session, objects, stats.walkReads, seen));
    stats.walk = performance.now() - started;
    // Without bundles every object is a read of its own: refused before the pack starts.
    if (count > FETCH_READS && !holdsBundles(objects.repo))
      throw overBudget(`${count} objects read one at a time`);
    // So is a pack that would carry a withheld blob (the counting pass saw every id).
    const withheld = await objects.withheldAll();
    const [held] = withheld.size ? session.holds([...withheld.keys()]) : [];
    if (held) throw quarantined(held, withheld.get(held) ?? null);
  } catch (e) {
    session.close();
    throw e;
  }
  const chunks = packChunks(session, objects, seen, early, budget, stats);
  return { count, chunks, close: () => session.close() };
}

/** History only a repository's mirror holds is not served here (its commits' exact bytes
 * are not in the store of record): an import's, until a purge retires the mirror and
 * copies it, or commits pushed before R2 held them. It is the oldest part of any history,
 * so the walk's oldest commit (`commits` are newest first) tells, before any of its trees
 * is read one by one through the mirror (dev, 2026-10-29: a clone right after an import
 * walked the mirror until it failed with HTTP 503). */
async function refuseMirrorOnly(objects: RepoObjects, commits: string[]) {
  const oldest = commits.at(-1);
  if (!oldest || !objects.store.cloneAccess) return;
  if ((await objects.raw([{ id: oldest, kind: 'commit' }])).length > 0) return;
  throw importedOnly(oldest);
}

const importedOnly = (id: string) =>
  new ApiError(
    'NOT_FOUND',
    `Commit ${id} is held only as imported history, which HTTPS does not serve yet; use git-remote-yoneda`,
  );

/** `wanted` read whole (`rawObjects`). */
async function readWhole(
  objects: RepoObjects,
  wanted: Wanted[],
  stats?: ReadStats,
  budget?: ReadBudget,
) {
  const read: Read[] = [];
  for await (const group of rawObjects(objects, wanted, stats, budget)) read.push(...group);
  return read;
}

/** The pack, in pieces of about `CHUNK` bytes: header, then wave by wave (`waves`) its
 * trees from the session, its commits read `early`, its other commits and blobs read in
 * groups (`rawObjects`), then the trailer. Closes the session. */
async function* packChunks(
  session: UploadSession,
  objects: RepoObjects,
  seen: SeenTrees,
  early: Promise<Read[]>,
  budget: ReadBudget,
  stats?: PackStats,
) {
  try {
    let pending: Uint8Array[] = [session.start()];
    let size = pending[0].length;
    /** Pack bytes, sent once about `CHUNK` gathered. */
    const push = function* (bytes: Uint8Array) {
      pending.push(bytes);
      size += bytes.length;
      if (size >= CHUNK) {
        yield concat(pending);
        pending = [];
        size = 0;
      }
    };
    const add = function* (entry: Uint8Array) {
      stats?.sent(entry);
      yield* push(entry);
    };
    const write = async function* (group: Read[]) {
      for (const { id, kind, data } of group) {
        if (!data)
          throw kind === 'commit'
            ? importedOnly(id)
            : new ApiError('NOT_FOUND', `${kind} ${id} is missing from the object store`);
        if (isLarge(data)) {
          if (stats) stats.raw += data.size;
          yield* add(session.largeStart(id, data.size));
          for await (const packed of deflated(session, data)) {
            stats?.streamed(packed.length);
            yield* push(packed);
          }
          session.largeEnd();
          continue;
        }
        if (stats) stats.raw += data.length;
        yield* add(session.entry(kind, id, data));
      }
    };
    const began = performance.now();
    let asked = began;
    const ahead = new Map((await early).map((o) => [o.id, o]));
    if (stats) stats.waited += performance.now() - asked;
    // A wave at a time: its trees (raw from what the walk kept: the session may have let
    // them go; any read only as entries go to the session first), its commits read ahead,
    // then its other commits and files read in groups; tag objects travel with the last.
    for (const wave of waves(session)) {
      const trees = await gather(
        objects,
        wave.trees,
        (id) => treeFor(objects, id),
        seen,
        stats?.walkReads,
      );
      if (trees.rest.length > 0) session.supply(trees.rest);
      for (const id of wave.trees) yield* add(session.entry('tree', id, trees.raw.get(id)));
      for (const id of wave.tags ?? []) yield* add(session.entry('tag', id));
      yield* write(wave.fetch.flatMap((w) => ahead.get(w.id) ?? []));
      const rest = wave.fetch.filter((w) => !ahead.delete(w.id));
      asked = performance.now();
      for await (const group of rawObjects(objects, rest, stats?.reads, budget)) {
        if (stats) stats.waited += performance.now() - asked;
        yield* write(group);
        asked = performance.now();
        // Fails as Git shows it (side-band), never a pack cut short in silence.
        if (asked - began > PACK_MS) throw overBudget(`more than ${PACK_MS / 60_000} minutes`);
      }
    }
    pending.push(session.finish());
    yield concat(pending);
  } finally {
    session.close();
  }
}
