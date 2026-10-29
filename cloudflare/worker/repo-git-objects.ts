// Object reads for Git over HTTPS: exact Git content for packs and trees for the walks
// that verify a push or enumerate a fetch, from the store of record first (a push's
// bundles in a few ranged reads, then one R2 object per key), and what a push's
// verification asks of the repository (`supply`).
import {
  fromBundles,
  HEADER,
  type Location,
  locate,
  RANGE,
  type ReadStats,
  readLocated,
  type Wanted,
  WIDE_GAP,
} from './repo-bundles';
import type { UploadSession } from './repo-git-sessions';
import { type LargeBody, largeBody } from './repo-large-files';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, type Json, type RepoContext } from './repo-ops';

/** Objects outside bundles read at a time, one R2 object each. */
const READS = 32;
/** Object-store reads one fetch may make (a Worker request has 50,000 subrequests; the
 * rest are its walk's and the authority's): past it the fetch fails, saying so. */
export const FETCH_READS = 40_000;

/** What a fetch has spent of FETCH_READS. */
export class ReadBudget {
  used = 0;
  constructor(readonly limit = FETCH_READS) {}
  spend(reads: number) {
    this.used += reads;
    if (this.used > this.limit) throw overBudget(`more than ${this.limit} object-store reads`);
  }
}

/** A fetch past the server's budget: what to do instead. */
export const overBudget = (what: string) =>
  new ApiError(
    'TOO_LARGE',
    `This fetch needs ${what}, past the server's budget for one request; clone with --filter=blob:none or --depth, or use git-remote-yoneda`,
  );

/** Repository reads in flight while verifying a push. */
const VERIFY_READS = 16;
/** Groups read while the one before them is written into the pack. */
const READ_AHEAD = 2;
/** Tree bytes a walk keeps from the ranges it read beyond the trees it asked for. */
const SEEN_BYTES = 32 * 1024 * 1024;
/** Commits the upload session walks together (platform_git_upload.rs WAVE_COMMITS): a
 * walk of more waves comes back to bundles it read, for trees an earlier wave dropped. */
const WAVE_COMMITS = 256;

/** A Git object's exact content: the store of record (R2), the authority's staged copy,
 * or (blobs only) the object store; `null` when none holds it. A large file comes as its
 * stream (`LargeBody`, repo-large-files), never read whole. */
export async function rawObject(
  objects: RepoObjects,
  id: string,
  kind: string,
): Promise<Uint8Array | LargeBody | null> {
  const stored = await objects.env.OBJECTS.get(objects.rawKey(id));
  if (stored && (stored.customMetadata?.kind ?? kind) === kind)
    return largeBody(stored) ?? new Uint8Array(await stored.arrayBuffer());
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
 * bundle about once, not once per object it lists in commit order. `stats` counts the
 * ranged reads.
 */
export async function* rawObjects(
  objects: RepoObjects,
  wanted: Wanted[],
  stats?: ReadStats,
  budget?: ReadBudget,
) {
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
    // A ranged read, and one read per object outside the bundles.
    budget?.spend(1 + group.filter((w) => !where.has(w.id)).length);
    const bundled = await readLocated(
      objects.env,
      objects.repo,
      group.flatMap((w) => where.get(w.id) ?? []),
      RANGE,
      { gap: WIDE_GAP, stats },
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
 * read for them (up to `SEEN_BYTES`), where later rounds find most of theirs unread. They
 * stay for the whole fetch: the session drops its own past TREE_BYTES, a wave's diffs
 * read trees earlier waves used, and the sending pass walks every wave again. */
export class SeenTrees {
  readonly trees = new Map<string, Uint8Array>();
  private bytes = 0;
  /** Reads per bundle, and the file bytes and other bytes they held. */
  private readonly bundles = new Map<string, { reads: number; files: number; others: number }>();
  private readonly waves: boolean;

  /** `commits`: how many the walk sends. */
  constructor(commits = 0) {
    this.waves = commits > WAVE_COMMITS;
  }

  /** In a walk of several waves, a bundle it comes back to is read whole, once, when what
   * it read of it was mostly commits and trees (a large push keeps those in bundles of
   * their own). A small fetch reads ranges only: a small push's files follow its trees. */
  whole = (bundle: string) => {
    const b = this.bundles.get(bundle) ?? { reads: 0, files: 0, others: 0 };
    this.bundles.set(bundle, { ...b, reads: b.reads + 1 });
    return this.waves && b.reads === 1 && b.files <= b.others;
  };
  keep = (kind: string, id: string, data: Uint8Array, bundle: string) => {
    const b = this.bundles.get(bundle);
    if (b) b[kind === 'blob' ? 'files' : 'others'] += data.length;
    if (kind !== 'tree' || this.trees.has(id) || this.bytes + data.length > SEEN_BYTES) return;
    this.trees.set(id, data.slice());
    this.bytes += data.length;
  };
}

/** Trees `ids` for a walk: those `seen` holds, bundled ones in a few ranged reads (with
 * `seen`, bridging `WIDE_GAP`, reading a bundle the walk comes back to whole, and keeping
 * every tree they hold), the rest through `read` (`treeFor`), `READS` at a time. */
export async function treesFor(
  objects: RepoObjects,
  ids: string[],
  read = (id: string) => treeFor(objects, id),
  seen?: SeenTrees,
  stats?: ReadStats,
) {
  const known: Json[] = [];
  const asked: string[] = [];
  for (const id of ids) {
    const data = seen?.trees.get(id);
    if (!data) asked.push(id);
    else known.push({ id, data_b64: toBase64(data) });
  }
  const bundled = await fromBundles(
    objects.env,
    objects.repo,
    asked.map((id) => ({ id, kind: 'tree' })),
    RANGE,
    seen ? { gap: WIDE_GAP, copy: true, frame: seen.keep, whole: seen.whole, stats } : { stats },
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

/** What verification asked for: recorded parents' trees, repository trees, and proof that
 * files the pack leaves out are held here. Anything missing refuses the push. */
export async function supply(ctx: RepoContext, objects: RepoObjects, need: Json): Promise<Json> {
  const missing = (what: string) =>
    new ApiError('NOT_FOUND', `missing necessary objects: ${what} is not in this repository`);
  if (need.commits) {
    const commits: Json = {};
    await inBatches(need.commits as string[], VERIFY_READS, async (id) => {
      const found = await ctx.call({ op: 'repo_commit', commit: id, brief: true }).catch((e) => {
        if (e?.code === 'NOT_FOUND') throw missing(`commit ${id}`);
        throw e;
      });
      commits[id] = found.tree;
    });
    return { commits };
  }
  if (need.trees) {
    const trees = await treesFor(objects, need.trees as string[], (id) =>
      treeFor(objects, id).catch((e) => {
        if (e?.code === 'NOT_FOUND') throw missing(`tree ${id}`);
        throw e;
      }),
    );
    return { trees };
  }
  // Files a bundle holds are present without reading them.
  const asked = need.objects as string[];
  const held = await locate(
    ctx.env,
    ctx.repo,
    asked.map((id) => ({ id, kind: 'blob' })),
  );
  const present = [...held.keys()];
  present.push(
    ...(await inBatches(
      asked.filter((id) => !held.has(id)),
      VERIFY_READS,
      async (id) => {
        const head = await ctx.env.OBJECTS.head(objects.rawKey(id));
        if (head?.customMetadata?.kind === 'blob' || (await rawObject(objects, id, 'blob')))
          return id;
        throw missing(`file ${id}`);
      },
    )),
  );
  return { present };
}

/** Counts what the pack holds (the session's counting pass), reading the trees each
 * wave of commits needs: `{count}`. */
export async function enumerate(
  session: UploadSession,
  objects: RepoObjects,
  stats?: ReadStats,
  seen = new SeenTrees(),
) {
  let step = session.step({});
  while (step.need_trees) {
    const trees = await treesFor(objects, step.need_trees as string[], undefined, seen, stats);
    step = session.step({ trees });
  }
  return step;
}

/** The session's sending pass: each wave's trees to write and objects to read, the last
 * with the tag objects (`done`). */
export async function* waves(
  session: UploadSession,
  objects: RepoObjects,
  seen = new SeenTrees(),
  stats?: ReadStats,
) {
  for (;;) {
    let wave = session.send({});
    while (wave.need_trees) {
      const trees = await treesFor(objects, wave.need_trees as string[], undefined, seen, stats);
      wave = session.send({ trees });
    }
    yield wave as { trees: string[]; fetch: Wanted[]; tags?: string[]; done: boolean };
    if (wave.done) return;
  }
}
