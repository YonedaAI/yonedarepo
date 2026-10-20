// Server-side merges. Landing work whose branch moved asks the authority for a merge
// plan, has Rust compute merge trees and blobs, records a platform merge commit and lands
// it with the authority's verification. Conflicts come back with diff3-marked text.

import { commit } from './repo-commit';
import { compute } from './repo-compute';
import { dispatchDerive } from './repo-derived';
import { keepAllowed, outside } from './repo-grants';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, caller, type Json, RepoContext } from './repo-ops';
import { dispatchProjection } from './repo-projection';
import { timed } from './repo-timing';

const PLATFORM_AUTHOR = { name: 'YonedaRepo', email: 'commits@yonedarepo.invalid' };
const SHA = /^[0-9a-f]{40}$/;

/** Rust three-way merge of `theirs` into `ours`, supplying trees and blobs on request. */
export async function mergeTrees(objects: RepoObjects, input: Json) {
  const trees: Json = {};
  const blobs: Json = {};
  for (let round = 0; round <= 128; round++) {
    const result = compute({ op: 'merge_trees', ...input, trees, blobs });
    if (result.need_trees)
      await Promise.all(
        (result.need_trees as string[]).map(async (id) => (trees[id] = await objects.tree(id))),
      );
    else if (result.need_blobs)
      await Promise.all(
        (result.need_blobs as string[]).map(
          async (id) => (blobs[id] = toBase64(await objects.blob(id))),
        ),
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

const LAND_DEADLINE_MS = 60_000;
const WAIT_FIRST_MS = 20;
const WAIT_MAX_MS = 320;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pathsOf = (changes: Json[]) => changes.map((c) => String(c.path));

/**
 * Builds and lands one claimed batch: every pending landing is merged against the head;
 * clean ones whose merged paths do not overlap an earlier item join one octopus merge
 * commit, overlapping ones wait for the next batch, conflicts fail with details.
 */
async function landBatch(merger: RepoContext, claim: Json) {
  const objects = await merger.objects();
  const accepted: Json[] = [];
  const failed: Json[] = [];
  const changes: Json[] = [];
  const touched = new Set<string>();
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
    return landed;
  }
  // Every item merges against the head on its own (stateless compute, side by side); the
  // batch then takes them in queue order while their merged paths stay disjoint.
  const merges = await timed('merge', () =>
    Promise.all(
      (claim.items as Json[]).map((item) =>
        mergeTrees(objects, {
          base: item.base_tree,
          ours: claim.head_tree,
          theirs: item.commit_tree,
        }),
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
    } else if (pathsOf(merged.changes).some((p) => touched.has(p)))
      continue; // next batch
    else {
      for (const p of pathsOf(merged.changes)) touched.add(p);
      changes.push(...merged.changes);
      accepted.push(item);
    }
  }
  if (accepted.length === 0)
    return merger.call({
      op: 'repo_land_batch',
      ref: claim.ref,
      epoch: claim.epoch,
      head: claim.head,
      landed: [],
      failed,
    });
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
  return landed;
}

/** After the branch moved: one projection and one derive job per move, sent by whoever
 * moved it (waiters whose work rode along send none). */
async function moved(ctx: RepoContext, ref: string) {
  await dispatchProjection(ctx.env, ctx.repo);
  await dispatchDerive(ctx.env, ctx.repo, ref);
}

/** Conflict details, refused outright if any conflict lies outside the caller's grant. */
async function scopedConflict(ctx: RepoContext, conflicts: Json[]) {
  const visible = await keepAllowed(ctx, conflicts);
  return visible.length === conflicts.length ? conflictError(conflicts) : outside();
}

/**
 * Lands `sha` on `ref`. A fast-forward lands directly; otherwise the landing joins the
 * branch's queue and this caller either claims the queue (and lands a whole batch) or
 * waits for whoever holds it. No caller ever rebuilds a merge against a moving head.
 */
export async function landWithMerge(
  ctx: RepoContext,
  ref: string,
  sha: string,
  fastForwardOnly = false,
) {
  try {
    const landed = await ctx.call({
      op: 'repo_land',
      ref,
      commit: sha,
      fast_forward_only: fastForwardOnly,
    });
    if (!landed.already) await moved(ctx, ref);
    return landed;
  } catch (e: any) {
    // A fast-forward-only landing never joins the merge queue.
    if (e?.code !== 'MERGE_REQUIRED' || fastForwardOnly) throw e;
  }
  const { ticket } = await ctx.call({ op: 'repo_land_enqueue', ref, commit: sha });
  const merger = new RepoContext(
    ctx.env,
    ctx.repo,
    caller(ctx.env, ctx.repo, { _system: 'merge' }),
  );
  const deadline = Date.now() + LAND_DEADLINE_MS;
  // Waiters back off: a hundred waiters polling every few milliseconds would starve the
  // commits and the merger they wait for.
  let pause = WAIT_FIRST_MS;
  const wait = async () => {
    await sleep(pause / 2 + Math.random() * pause);
    pause = Math.min(pause * 2, WAIT_MAX_MS);
  };
  while (Date.now() < deadline) {
    // The claim answers for this ticket once it is settled: one authority call per poll.
    const claim = await merger.call({ op: 'repo_land_claim', ref, ticket });
    const status = claim.settled ?? { status: 'pending' };
    if (status.status === 'landed') {
      const via = status.result?.commit;
      return {
        landed: true,
        ref: status.ref,
        commit: sha,
        version: status.result?.version,
        ...(via && via !== sha ? { merge: via, merged: sha } : {}),
      };
    }
    if (status.status === 'failed') {
      const { code, message, details } = status.result ?? {};
      throw new ApiError(code ?? 'CONFLICT', message ?? 'Landing failed', details);
    }
    if (status.status !== 'pending') throw new ApiError('INVALID_INPUT', 'Unknown landing state');
    if (claim.wait) {
      await wait();
      continue;
    }
    if (claim.empty || !claim.items?.length) {
      if (!claim.empty) await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch });
      continue;
    }
    try {
      await landBatch(merger, claim);
    } catch (e: any) {
      await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch }).catch(() => {});
      // Lost the compare-and-swap (the branch moved while the batch was built): rebuild.
      if (e?.code !== 'STALE_HEAD') throw e;
    }
  }
  throw new ApiError('TIMEOUT', `Landing on ${ref} is still queued; check ticket ${ticket}`, {
    ticket,
  });
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
