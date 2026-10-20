// Landing a commit on a branch. A fast-forward lands directly; anything else joins the
// branch's queue, which is drained in one of three modes (benchmarked side by side):
// `changeset` appends path-disjoint work to the log without Git objects (repo-changesets),
// `combiner` builds batch merge commits in the branch's combiner, `poll` has the waiting
// landers build them. Work on the same files always takes the merge path.

import { deferred } from './background';
import { awaitProjection, type LandMode, landMode } from './repo-changesets';
import { pollLanding } from './repo-land-poll';
import { moved } from './repo-merge';
import { ApiError, batch, caller, type Json, RepoContext } from './repo-ops';
import { adoptCommit, forgetChain, shardChain } from './repo-shards';
import { timed } from './repo-timing';

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
 * Lands `sha` on `ref`. A fast-forward lands directly; otherwise the landing joins the
 * branch's queue and this caller waits for the branch's combiner (or, in `poll` mode or
 * without one, drains the queue itself). No caller rebuilds a merge against a moving head.
 */
export async function landWithMerge(
  ctx: RepoContext,
  ref: string,
  sha: string,
  fastForwardOnly = false,
  mode: LandMode = landMode(ctx.env),
) {
  // Lands directly, or joins the branch's queue in the same call (never fast-forward-only).
  const land = {
    op: 'repo_land',
    ref,
    commit: sha,
    fast_forward_only: fastForwardOnly,
    ...(fastForwardOnly ? {} : { enqueue: true }),
  };
  const landed = await timed('land.request', () => adoptAndLand(ctx, sha, land));
  if (!landed.queued) {
    if (!landed.already) await moved(ctx, ref);
    return landed;
  }
  const { ticket } = landed;
  const merger = new RepoContext(
    ctx.env,
    ctx.repo,
    caller(ctx.env, ctx.repo, { _system: 'merge' }),
  );
  const deadline = Date.now() + LAND_DEADLINE_MS;
  // The branch's combiner lands the batches and answers when this ticket settles; waiting
  // there costs the authority nothing. Without one (or if it is evicted), poll.
  const combiners = ctx.env.LAND_COMBINERS;
  if (combiners && mode !== 'poll') {
    const combiner = combiners.get(combiners.idFromName(`${ctx.repo}:${ref}`)) as unknown as {
      wait(
        repo: string,
        ref: string,
        ticket: number,
        timeoutMs: number,
        mode: LandMode,
      ): Promise<Json | null>;
    };
    try {
      while (Date.now() < deadline) {
        const settled = await timed('land.wait', () =>
          combiner.wait(
            ctx.repo,
            ref,
            ticket,
            Math.min(WAIT_ROUND_MS, deadline - Date.now()),
            mode,
          ),
        );
        if (settled) return outcome(sha, settled);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
  }
  return outcome(sha, await pollLanding(merger, ref, ticket, deadline, mode));
}
