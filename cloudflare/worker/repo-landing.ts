// Landing a commit on a branch. In batch mode (the default) the lander submits its
// commit's shard record to the branch's combiner, which lands every waiting submission in
// one authority call; otherwise (changeset mode, an adopted commit) a fast-forward lands
// directly and anything else joins the branch's queue, which the combiner drains.
// Path-disjoint work appends changesets without Git objects (repo-changesets); work on
// the same files takes the merge path.

import { deferred } from './background';
import { awaitProjection, type LandMode, landMode } from './repo-changesets';
import { forgetHead } from './repo-head';
import { pollLanding } from './repo-land-poll';
import { moved } from './repo-merge';
import { ApiError, batch, caller, type Json, RepoContext } from './repo-ops';
import { adoptCommit, forgetChain, shardChain, shardRecord } from './repo-shards';
import { record, timed } from './repo-timing';

const LAND_DEADLINE_MS = 120_000;
const WAIT_ROUND_MS = 20_000;

/**
 * Lands `sha`, adopting it first if it is still in its shard: the adoption (as the
 * platform) and the landing (as the caller) travel in one authority request, each in its
 * own transaction, so a thousand landers cost the authority a thousand requests, not two.
 */
async function adoptAndLand(ctx: RepoContext, sha: string, land: Json) {
  const chain = await shardChain(ctx.env, ctx.repo, sha);
  if (chain.length === 0) return ctx.call(land);
  const adopter = caller(ctx.env, ctx.repo, { _system: 'commits' });
  const [adopted, landed] = await batch(ctx.env, ctx.repo, [
    adopter.sign({ op: 'repo_adopt_commit', records: chain }),
    ctx.call.sign(land),
  ]);
  if (adopted.error) {
    // An ancestor's record moved mid-walk (a racing adoption): adopt stepwise, land again.
    await adoptCommit(ctx.env, ctx.repo, sha);
    return ctx.call(land);
  }
  // Dropping the shard records can wait for after the answer when the request allows it.
  const forget = () => forgetChain(ctx.env, ctx.repo, chain);
  if (!deferred(forget)) await forget();
  if (landed.error?.code === 'PROJECTION_PENDING') {
    // A fast-forward-only landing compares against the latest version's Git commit.
    await awaitProjection(ctx.env, ctx.repo);
    return ctx.call(land);
  }
  // A concurrent window reaching archived versions: the caller fetches them and retries.
  if (landed.error?.code === 'TXLOG_ARCHIVED') return ctx.call(land);
  if (landed.error) throw new ApiError(landed.error.code, landed.error.message);
  return landed;
}

/** A settled ticket as the landing's answer (a changeset's Git commit may be pending). */
function outcome(sha: string, status: Json) {
  if (status.status === 'landed') {
    const result = status.result ?? {};
    if (result.changeset)
      return {
        landed: true,
        ref: status.ref,
        commit: sha,
        version: result.version,
        git_commit: result.commit ?? null,
      };
    const via = result.commit;
    return {
      landed: true,
      ref: status.ref,
      commit: sha,
      version: result.version,
      ...(via && via !== sha ? { merge: via, merged: sha } : {}),
    };
  }
  if (status.status === 'failed') {
    const { code, message, details } = status.result ?? {};
    throw new ApiError(code ?? 'CONFLICT', message ?? 'Landing failed', details);
  }
  throw new ApiError('INVALID_INPUT', 'Unknown landing state');
}

/**
 * Lands `sha` on `ref` (see the module comment). A queued landing waits for the branch's
 * combiner, or drains the queue itself when the combiner cannot be reached. No caller
 * rebuilds a merge against a moving head. `inAuthority`: the caller knows the authority
 * already records `sha` (a commit pushed with Git), so no shard is asked for it.
 */
export async function landWithMerge(
  ctx: RepoContext,
  ref: string,
  sha: string,
  fastForwardOnly = false,
  mode: LandMode = landMode(ctx.env),
  inAuthority = false,
) {
  const landed = await landOn(ctx, ref, sha, fastForwardOnly, mode, inAuthority);
  // This isolate's next read and begin see its own landing (others pass min_version).
  forgetHead(ctx.repo, typeof landed.version === 'number' ? landed.version : undefined, sha);
  return landed;
}

async function landOn(
  ctx: RepoContext,
  ref: string,
  sha: string,
  fastForwardOnly: boolean,
  mode: LandMode,
  inAuthority: boolean,
) {
  // Batched landing serves main (the branch with a published head); other branches, and
  // a branch landed for the first time, take the queued path.
  const main = ref === 'main' || ref === 'refs/heads/main';
  if (mode === 'batch' && main && !fastForwardOnly && ctx.env.LAND_COMBINERS && !inAuthority) {
    // Batched landing takes the commit's shard record; an adopted commit lands as before.
    const own = await timed('land.record', () => shardRecord(ctx.env, ctx.repo, sha));
    const submitted = own && (await landSubmitted(ctx, ref, sha, own));
    if (submitted) return submitted;
  }
  // Lands directly, or joins the branch's queue in the same call (never fast-forward-only).
  const land = {
    op: 'repo_land',
    ref,
    commit: sha,
    fast_forward_only: fastForwardOnly,
    ...(fastForwardOnly ? {} : { enqueue: true }),
  };
  const landed = await timed('land.request', () =>
    inAuthority ? ctx.call(land) : adoptAndLand(ctx, sha, land),
  );
  if (!landed.queued) {
    if (!landed.already) await moved(ctx, ref);
    return landed;
  }
  return awaitTicket(ctx, ref, sha, landed.ticket, Date.now() + LAND_DEADLINE_MS);
}

type Combiner = {
  wait(repo: string, ref: string, ticket: number, timeoutMs: number): Promise<Json | null>;
  submit(repo: string, ref: string, item: Json, timeoutMs: number): Promise<Json | null>;
};

/**
 * Batch mode: submits the commit's shard records with this caller's credentials to the
 * branch's combiner, which lands every waiting submission in one authority call. Nothing
 * waits in the authority, so a submission that timed out is simply sent again (a landed
 * commit answers with its version). Returns null when the combiner cannot be reached.
 */
async function landSubmitted(ctx: RepoContext, ref: string, sha: string, own: Json) {
  const combiners = ctx.env.LAND_COMBINERS as DurableObjectNamespace;
  const combiner = combiners.get(combiners.idFromName(`${ctx.repo}:${ref}`)) as unknown as Combiner;
  let item = { credentials: ctx.call.sign({}), records: [own] };
  const deadline = Date.now() + LAND_DEADLINE_MS;
  while (Date.now() < deadline) {
    const out = await timed('land.submit', () =>
      combiner.submit(ctx.repo, ref, item, Math.min(WAIT_ROUND_MS, deadline - Date.now())),
    ).catch((e) => {
      if (e instanceof ApiError) throw e;
      return undefined; // the combiner cannot be reached
    });
    // Without a combiner, the landing takes the queued path (which polls).
    if (out === undefined) return null;
    if (!out) continue;
    if (out.batch) record('land.batch', out.batch.ms, out.batch.size);
    if (out.queued_ms !== undefined) record('land.queued', out.queued_ms);
    if (out.status === 'landed')
      return { landed: true, ref, commit: sha, version: out.version, git_commit: null };
    // A commit on unlanded parents needs the merge path, which adopts its whole chain.
    if (out.status === 'need_chain') {
      item = { ...item, records: await shardChain(ctx.env, ctx.repo, sha) };
      continue;
    }
    if (out.status === 'queued') return awaitTicket(ctx, ref, sha, out.ticket, deadline);
    throw new ApiError(out.code ?? 'CONFLICT', out.message ?? 'Landing failed');
  }
  throw new ApiError(
    'TIMEOUT',
    `Landing ${sha} on ${ref} was not settled in time; submit it again`,
  );
}

/** Waits for a queued ticket on the branch's combiner, or polls without one. */
async function awaitTicket(
  ctx: RepoContext,
  ref: string,
  sha: string,
  ticket: number,
  deadline: number,
) {
  const merger = new RepoContext(
    ctx.env,
    ctx.repo,
    caller(ctx.env, ctx.repo, { _system: 'merge' }),
  );
  // The branch's combiner lands the batches and answers when this ticket settles; waiting
  // there costs the authority nothing. Without one (or if it is evicted), poll.
  const combiners = ctx.env.LAND_COMBINERS;
  if (combiners) {
    const combiner = combiners.get(
      combiners.idFromName(`${ctx.repo}:${ref}`),
    ) as unknown as Combiner;
    try {
      while (Date.now() < deadline) {
        const settled = await timed('land.wait', () =>
          combiner.wait(ctx.repo, ref, ticket, Math.min(WAIT_ROUND_MS, deadline - Date.now())),
        );
        if (settled) return outcome(sha, settled);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
  }
  return outcome(sha, await pollLanding(merger, ref, ticket, deadline));
}
