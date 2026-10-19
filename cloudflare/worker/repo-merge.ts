// Server-side merges. Landing work whose branch moved asks the authority for a merge
// plan, has Rust compute merge trees and blobs, records a platform merge commit and lands
// it with the authority's verification. Conflicts come back with diff3-marked text.

import { compute } from './repo-compute';
import { fromBase64, type RepoObjects, toBase64 } from './repo-objects';
import { ApiError, caller, commit, type Json, RepoContext } from './repo-ops';

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
  }));
  return new ApiError(
    'CONFLICT',
    `Three-way merge conflicts on ${details.map((d) => `${d.path} (${d.kind})`).join(', ')}`,
    { conflicts: details },
  );
}

const LAND_DEADLINE_MS = 60_000;
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
  if (fastForward)
    return merger.call({
      op: 'repo_land_batch',
      ref: claim.ref,
      epoch: claim.epoch,
      landed: [fastForward.ticket],
    });
  for (const item of claim.items as Json[]) {
    const merged = await mergeTrees(objects, {
      base: item.base_tree,
      ours: claim.head_tree,
      theirs: item.commit_tree,
    });
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
  return merger.call({
    op: 'repo_land_batch',
    ref: claim.ref,
    epoch: claim.epoch,
    merge: made.commit,
    landed: accepted.map((item) => item.ticket),
    failed,
  });
}

/**
 * Lands `sha` on `ref`. A fast-forward lands directly; otherwise the landing joins the
 * branch's queue and this caller either claims the queue (and lands a whole batch) or
 * waits for whoever holds it. No caller ever rebuilds a merge against a moving head.
 */
export async function landWithMerge(ctx: RepoContext, ref: string, sha: string) {
  try {
    return await ctx.call({ op: 'repo_land', ref, commit: sha });
  } catch (e: any) {
    if (e?.code !== 'MERGE_REQUIRED') throw e;
  }
  const { ticket } = await ctx.call({ op: 'repo_land_enqueue', ref, commit: sha });
  const merger = new RepoContext(
    ctx.env,
    ctx.repo,
    caller(ctx.env, ctx.repo, { _system: 'merge' }),
  );
  const deadline = Date.now() + LAND_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = await ctx.call({ op: 'repo_land_status', ticket });
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
    const claim = await merger.call({ op: 'repo_land_claim', ref });
    if (claim.wait) {
      await sleep(5 + Math.random() * 20);
      continue;
    }
    if (claim.empty || !claim.items?.length) {
      if (!claim.empty) await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch });
      continue;
    }
    try {
      await landBatch(merger, claim);
    } catch (e) {
      await merger.call({ op: 'repo_land_release', ref, epoch: claim.epoch }).catch(() => {});
      throw e;
    }
  }
  throw new ApiError('TIMEOUT', `Landing on ${ref} is still queued; check ticket ${ticket}`, {
    ticket,
  });
}

/** `git merge <source>` into branch `into`: creates (does not land) a merge commit. */
export async function explicitMerge(ctx: RepoContext, args: Json) {
  const into = String(args.into ?? 'main');
  const head = await ctx.call({ op: 'repo_snapshot', ref: into });
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
  if (merged.conflicts.length > 0) throw conflictError(merged.conflicts);
  return commit(ctx, objects, {
    parent: head.commit,
    merge_parent: source.commit,
    base_version: head.version,
    changes: merged.changes,
    message: args.message ?? `Merge ${args.source} into ${into}`,
    author: args.author ?? PLATFORM_AUTHOR,
  });
}
