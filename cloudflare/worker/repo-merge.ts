// Server-side merges. Landing work whose branch moved asks the authority for a merge
// plan, has Rust compute merge trees and blobs, records a platform merge commit and lands
// it with the authority's verification. Conflicts come back with diff3-marked text.

import { commit } from './repo-commit';
import { compute } from './repo-compute';
import { dispatchDerive } from './repo-derived';
import { keepAllowed, outside } from './repo-grants';
import { type CachedObject, fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, caller, type Json, type RepoContext } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import { shardStagedOf } from './repo-shards';
import { timed } from './repo-timing';

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };
const SHA = /^[0-9a-f]{40}$/;

/** Rust three-way merge of `theirs` into `ours`, supplying trees and blobs on request. */
export async function mergeTrees(objects: RepoObjects, input: Json, known: CachedObject[] = []) {
  const trees: Json = {};
  const blobs: Json = {};
  // Objects already in hand (prefetched from where they are staged) skip the tiers.
  const held = new Map(known.map((o) => [o.id, o]));
  const tree = async (id: string) => {
    const object = held.get(id);
    return object?.kind === 'tree' ? object.entries : objects.tree(id);
  };
  const blob = async (id: string) => {
    const object = held.get(id);
    return object?.kind === 'blob' ? object.data_b64 : toBase64(await objects.blob(id));
  };
  for (let round = 0; round <= 128; round++) {
    const result = compute({ op: 'merge_trees', ...input, trees, blobs });
    if (result.need_trees)
      await Promise.all(
        (result.need_trees as string[]).map(async (id) => (trees[id] = await tree(id))),
      );
    else if (result.need_blobs)
      await Promise.all(
        (result.need_blobs as string[]).map(async (id) => (blobs[id] = await blob(id))),
      );
    else return result as { changes: Json[]; conflicts: Json[] };
  }
  throw new ApiError('INVALID_INPUT', 'Merge did not converge');
}

function conflictError(conflicts: Json[]) {
  const details = conflicts.map((c) => ({
    path: c.path,
    kind: c.kind,
    ...(c.marked_b64 ? { marked: new TextDecoder().decode(fromBase64(c.marked_b64)) } : {}),
    ...(c.regions ? { regions: c.regions } : {}),
    // The three sides by blob id, for a reconcile commit.
    ...(c.ours ? { base: c.base ?? null, ours: c.ours, theirs: c.theirs } : {}),
  }));
  return new ApiError(
    'CONFLICT',
    `Three-way merge conflicts on ${details.map((d) => `${d.path} (${d.kind})`).join(', ')}`,
    { conflicts: details },
  );
}

const pathsOf = (changes: Json[]) => changes.map((c) => String(c.path));

/** Paths meet when equal or when one is a directory of the other (as in log validation). */
function overlaps(a: string, b: string) {
  const within = (inner: string, outer: string) =>
    (outer.endsWith('/') && inner.startsWith(outer)) || inner.startsWith(`${outer}/`);
  return a === b || within(a, b) || within(b, a);
}

/** Write skew within a batch (Adya G2-item): a member may neither read nor write what an
 * earlier accepted member writes; with no declared reads its writes count as reads. */
function skews(item: Json, written: string[]) {
  const keys = [...(item.reads ?? []), ...(item.writes ?? [])].map((k) => String(k).split('#')[0]);
  return keys.some((key) => written.some((w) => overlaps(key, w)));
}

/**
 * Builds and lands one claimed batch: every pending landing is merged against the head;
 * clean ones whose merged paths do not overlap an earlier item join one octopus merge
 * commit, overlapping ones wait for the next batch, conflicts fail with details.
 */
/** A ticket's outcome, as the authority's land status reports it. */
export type Settled = { ticket: number; status: 'landed' | 'failed'; ref?: string; result: Json };

/**
 * Builds and lands one claimed batch and returns every ticket it settled (landed, failed
 * here or failed by the claim's stale-read check); deferred tickets stay queued.
 */
export async function landBatch(merger: RepoContext, claim: Json): Promise<Settled[]> {
  const early: Settled[] = claim.failed ?? [];
  const landedAs = (tickets: number[], out: Json): Settled[] =>
    tickets.map((ticket) => ({
      ticket,
      status: 'landed',
      ref: claim.ref,
      result: { version: out.version, commit: out.commit },
    }));
  const failedAs = (list: Json[]): Settled[] =>
    list.map((f) => ({ ticket: f.ticket, status: 'failed', result: f.error }));
  const objects = await merger.objects();
  const accepted: Json[] = [];
  const failed: Json[] = [];
  const changes: Json[] = [];
  const touched = new Set<string>();
  const written: string[] = [];
  const fastForward = claim.items.find((item: Json) => item.fast_forward);
  if (fastForward) {
    const landed = await merger.call({
      op: 'repo_land_batch',
      ref: claim.ref,
      epoch: claim.epoch,
      head: claim.head,
      landed: [fastForward.ticket],
    });
    await moved(merger, claim.ref);
    return [...early, ...landedAs([fastForward.ticket], landed)];
  }
  // Fresh objects are still staged (in their commit's shard, or the authority for the
  // previous batch merge): fetch each commit's in one call rather than walking the tiers
  // object by object, which from the combiner's colo means a miss at every tier.
  const known = (
    await Promise.all([
      stagedOf(merger, claim.head),
      ...(claim.items as Json[]).map((item) => stagedOf(merger, item.commit)),
    ])
  ).flat();
  // Every item merges against the head on its own (stateless compute, side by side); the
  // batch then takes them in queue order while their merged paths stay disjoint.
  const merges = await timed('merge', () =>
    Promise.all(
      (claim.items as Json[]).map((item) =>
        mergeTrees(
          objects,
          { base: item.base_tree, ours: claim.head_tree, theirs: item.commit_tree },
          known,
        ),
      ),
    ),
  );
  for (const [index, item] of (claim.items as Json[]).entries()) {
    const merged = merges[index];
    if (merged.conflicts.length > 0) {
      const error = conflictError(merged.conflicts);
      failed.push({
        ticket: item.ticket,
        error: { code: error.code, message: error.message, details: error.details },
      });
    } else if (skews(item, written) || pathsOf(merged.changes).some((p) => touched.has(p)))
      continue; // next batch, validated against a log that holds the earlier members
    else {
      written.push(...(item.writes ?? []));
      for (const p of pathsOf(merged.changes)) touched.add(p);
      changes.push(...merged.changes);
      accepted.push(item);
    }
  }
  if (accepted.length === 0) {
    await merger.call({
      op: 'repo_land_batch',
      ref: claim.ref,
      epoch: claim.epoch,
      head: claim.head,
      landed: [],
      failed,
    });
    return [...early, ...failedAs(failed)];
  }
  const branch = String(claim.ref).replace(/^refs\/heads\//, '');
  const made = await commit(merger, objects, {
    parent: claim.head,
    merge_parents: accepted.map((item) => item.commit),
    base_version: claim.version,
    changes,
    message:
      accepted.length === 1
        ? `Merge ${String(accepted[0].commit).slice(0, 10)} into ${branch}`
        : `Merge ${accepted.length} landings into ${branch}\n\n${accepted.map((i) => i.commit).join('\n')}`,
    author: PLATFORM_AUTHOR,
  });
  const landed = await merger.call({
    op: 'repo_land_batch',
    ref: claim.ref,
    epoch: claim.epoch,
    head: claim.head,
    merge: made.commit,
    landed: accepted.map((item) => item.ticket),
    failed,
  });
  await moved(merger, claim.ref);
  return [
    ...early,
    ...failedAs(failed),
    ...landedAs(
      accepted.map((i) => i.ticket),
      landed,
    ),
  ];
}

/** A commit's staged objects (its shard's copy, else the authority's), or none. */
export async function stagedOf(merger: RepoContext, commit: string): Promise<CachedObject[]> {
  const fromShard = await shardStagedOf(merger.env, merger.repo, commit);
  if (fromShard.length) return fromShard;
  const here = await caller(merger.env, merger.repo, { _system: 'projection' })({
    op: 'repo_staged_objects',
    commit,
  }).catch(() => ({ objects: [] }));
  return here.objects as CachedObject[];
}

/** After the branch moved: one projection and one derive job per move, sent by whoever
 * moved it (waiters whose work rode along send none). */
export async function moved(ctx: RepoContext, ref: string) {
  // The landing already happened: a lost message delays projection and derived data (the
  // next move or a projector retry catches up), it does not undo or fail the landing.
  await Promise.all([
    dispatchProjection(ctx.env, ctx.repo),
    dispatchDerive(ctx.env, ctx.repo, ref),
  ]).catch((e) => console.warn(`dispatch after landing failed: ${e?.message ?? e}`));
}

/** Conflict details, refused outright if any conflict lies outside the caller's grant. */
async function scopedConflict(ctx: RepoContext, conflicts: Json[]) {
  const visible = await keepAllowed(ctx, conflicts);
  return visible.length === conflicts.length ? conflictError(conflicts) : outside();
}

/**
 * `git merge <source>` into branch (or commit) `into`: creates (does not land) a merge
 * commit. With `on_conflict: "workspace"`, conflicts do not fail the call: it records a
 * two-parent workspace commit holding every cleanly merged path (conflicted paths keep
 * `into`'s bytes) and returns it with the conflicting paths, for a resolver to finish.
 */
export async function explicitMerge(ctx: RepoContext, args: Json) {
  const into = String(args.into ?? 'main');
  const head = SHA.test(into)
    ? await ctx.call({ op: 'repo_commit', commit: into })
    : await ctx.call({ op: 'repo_snapshot', ref: into });
  const source = SHA.test(args.source ?? '')
    ? await ctx.call({ op: 'repo_commit', commit: args.source })
    : await ctx
        .call({ op: 'repo_snapshot', ref: args.source })
        .then((s) => ctx.call({ op: 'repo_commit', commit: s.commit }));
  const { merge_bases } = await ctx.call({
    op: 'repo_merge_base',
    left: head.commit,
    right: source.commit,
  });
  const base = merge_bases[0];
  if (base?.commit === source.commit) return { up_to_date: true, head: head.commit };
  if (base?.commit === head.commit) return { fast_forward: source.commit, head: head.commit };
  const objects = await ctx.objects();
  const merged = await mergeTrees(objects, {
    base: base?.tree ?? null,
    ours: head.tree,
    theirs: source.tree,
  });
  const merge = (changes: Json[]) =>
    commit(ctx, objects, {
      parent: head.commit,
      merge_parent: source.commit,
      base_version: head.version ?? head.base_version ?? 0,
      changes,
      message: args.message ?? `Merge ${args.source} into ${into}`,
      author: args.author ?? PLATFORM_AUTHOR,
    });
  if (merged.conflicts.length === 0) return merge(merged.changes);
  if (args.on_conflict !== 'workspace') throw await scopedConflict(ctx, merged.conflicts);
  const conflicted = new Set(merged.conflicts.map((c) => String(c.path)));
  if ((await keepAllowed(ctx, merged.conflicts)).length !== merged.conflicts.length)
    throw outside();
  const clean = merged.changes.filter((c) => !conflicted.has(String(c.path)));
  const workspace = await merge(clean);
  return {
    conflicts: merged.conflicts.map((c) => ({ path: c.path, kind: c.kind })),
    workspace: workspace.commit,
    tree: workspace.tree,
    parents: workspace.parents,
    merged_paths: pathsOf(clean),
  };
}
