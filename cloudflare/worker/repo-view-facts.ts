// Facts of every file a revision-wide view analyses (repo-views). Read a file at a time, a
// cold overview of a few hundred files waited on a cache read each and, on a miss, a blob
// read and a compute each (19.6 s live). Facts depend only on a blob's content and language
// and a root tree id names a whole revision, so an unrestricted view's facts are one object
// keyed by the root tree: a warm view is one read. A new revision starts from the latest
// such object and computes only the files it lacks, their content read in one pass of
// bundled ranged reads; the derive job builds each new head's object before anyone asks.
// A caller limited to a directory grant never reads or writes a revision's object (it is
// built from files the caller may not see): its view uses per-file facts instead.
import { afterAnswer } from './background';
import { compute } from './repo-compute';
import { factsKey, factsName, recordsFor } from './repo-contracts';
import { inBatches } from './repo-git-objects';
import { grantOf, keepAllowed } from './repo-grants';
import { withObjects } from './repo-object-compute';
import { blobWaves } from './repo-object-waves';
import { toBase64 } from './repo-objects';
import { type Json, type RepoContext, SHA } from './repo-ops';
import { timed } from './repo-timing';

/** Per-file cache reads and writes in flight. */
const FACTS_BATCH = 32;

type ViewFile = { path: string; id: string };
/** A revision's view files with their facts, and whether the view's file bound cut it. */
export type ViewFacts = {
  files: (ViewFile & { facts: Json })[];
  truncated: boolean;
  limit: number;
};

/** Keyed like the per-file cache (`v1`: platform_facts.rs FACTS_VERSION; bump together). */
const viewKey = (repo: string, name: string) => `derived/v1/${repo}/view-facts/v1/${name}`;
const nameOf = (f: ViewFile) => factsName(f.path, f.id);

/**
 * Every file a revision-wide view may analyse: inside the caller's grant (hidden files
 * never enter the computation, so nothing about them can leak into a view), in a
 * supported language, bounded in number. Each comes with its facts.
 */
export async function viewFacts(ctx: RepoContext, tree: string): Promise<ViewFacts> {
  const whole = (await grantOf(ctx)) === null;
  if (whole) {
    const stored = await timed('view.facts', () => ctx.env.OBJECTS.get(viewKey(ctx.repo, tree)));
    if (stored) return stored.json<ViewFacts>();
  }
  const { changes } = await timed('view.tree', () =>
    withObjects(ctx, { op: 'tree_diff', old: null, new: tree }),
  );
  const listed = (changes as Json[]).map((c) => ({
    path: c.path,
    id: c.new?.id,
    type: c.new?.type,
  }));
  const plan = compute({ op: 'view_files', files: await keepAllowed(ctx, listed) });
  const wanted = plan.files as ViewFile[];
  const known = await timed('view.known', () =>
    whole ? latestFacts(ctx) : cachedFacts(ctx, wanted),
  );
  const fresh = await timed('view.build', () =>
    computeFacts(
      ctx,
      wanted.filter((f) => !known.has(nameOf(f))),
    ),
  );
  // Every file is in one of the two: a blob no tier holds fails the view, as it always did.
  const facts = (f: ViewFile) => (known.get(nameOf(f)) ?? fresh.get(nameOf(f))) as Json;
  const built: ViewFacts = {
    files: wanted.map((f) => ({ ...f, facts: facts(f) })),
    truncated: plan.truncated as boolean,
    limit: plan.limit as number,
  };
  // After the answer: a lost write only costs the next view its speed.
  await afterAnswer(() =>
    (whole ? storeRevision(ctx, tree, built) : storeFiles(ctx, wanted, fresh)).catch((e) =>
      console.warn(`view facts not stored: ${e?.message ?? e}`),
    ),
  );
  return built;
}

/** `viewFacts` with the authored contract records of its files, as of log version `at`. */
export async function revisionFiles(ctx: RepoContext, tree: string, at?: unknown) {
  const { files, truncated, limit } = await viewFacts(ctx, tree);
  const records = await timed('view.records', () =>
    recordsFor(
      ctx,
      files.map((f) => f.path),
      at,
    ),
  );
  return { files, records, truncated, limit };
}

/** The facts of the latest revision whose view was built, by file name: most of a new
 * revision's files are unchanged. */
async function latestFacts(ctx: RepoContext) {
  const known = new Map<string, Json>();
  const tree = await (await ctx.env.OBJECTS.get(viewKey(ctx.repo, 'latest')))?.text();
  const base = tree && SHA.test(tree) ? await ctx.env.OBJECTS.get(viewKey(ctx.repo, tree)) : null;
  if (base) for (const f of (await base.json<ViewFacts>()).files) known.set(nameOf(f), f.facts);
  return known;
}

/** Per-file cached facts of `files`, by file name. */
async function cachedFacts(ctx: RepoContext, files: ViewFile[]) {
  const known = new Map<string, Json>();
  await inBatches(files, FACTS_BATCH, async (f) => {
    const cached = await ctx.env.OBJECTS.get(factsKey(ctx.repo, f.path, f.id));
    if (cached) known.set(nameOf(f), await cached.json<Json>());
  });
  return known;
}

/** Facts of `files`, their content read in one pass (bundled ones in a few ranged reads). */
async function computeFacts(ctx: RepoContext, files: ViewFile[]) {
  const fresh = new Map<string, Json>();
  const pathsOf = new Map<string, string[]>();
  for (const f of files) pathsOf.set(f.id, [...(pathsOf.get(f.id) ?? []), f.path]);
  for await (const wave of blobWaves(await ctx.objects(), [...pathsOf.keys()]))
    for (const [id, data] of wave) {
      const blobs = { [id]: toBase64(data) };
      for (const path of pathsOf.get(id) ?? []) {
        const name = nameOf({ path, id });
        if (!fresh.has(name)) fresh.set(name, compute({ op: 'code_facts', path, id, blobs }));
      }
    }
  return fresh;
}

/** The revision's facts, then the pointer a later revision starts from. */
async function storeRevision(ctx: RepoContext, tree: string, built: ViewFacts) {
  await ctx.env.OBJECTS.put(viewKey(ctx.repo, tree), JSON.stringify(built));
  await ctx.env.OBJECTS.put(viewKey(ctx.repo, 'latest'), tree);
}

async function storeFiles(ctx: RepoContext, files: ViewFile[], fresh: Map<string, Json>) {
  await inBatches(
    files.filter((f) => fresh.has(nameOf(f))),
    FACTS_BATCH,
    (f) =>
      ctx.env.OBJECTS.put(factsKey(ctx.repo, f.path, f.id), JSON.stringify(fresh.get(nameOf(f)))),
  );
}
