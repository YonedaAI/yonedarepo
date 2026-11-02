// The clearance job, CTC's first: lands an open Landing once its exact head has cleared, for a
// repository with the switch on. The authority decides, in one pure function
// (platform_ctc.rs), and records each decision with its reasons and the head it judged. This
// carries out what only an adapter can: a fork's newest head and the landing, which names the
// head it evaluated so a newer push can't slip in. The platform evaluates rules and moves a ref;
// it starts no agent, and no model is asked anything. A refused or conflicted landing leaves the
// Landing open with its reason, and only the next trigger tries again. Queues deliver at least
// once: a duplicate finds the Landing landed, or shares its queue ticket.
import { log, warned } from './log';
import { recordJob } from './platform-client-events';
import { landMode } from './repo-changesets';
import { followForkChange } from './repo-forks';
import { HOLD_LIFTED, landChecksOn } from './repo-land-check';
import { landWithMerge } from './repo-landing';
import { ApiError, caller, RepoContext } from './repo-ops';
import { refusalReason } from './repo-usage';
import type { Env, Envelope } from './types';

/** Tries of one job for an answer that says nothing about the Landing itself. */
const ATTEMPTS = 3;
const RETRY_S = 30;
/** Not an answer about the Landing: the ticket may still land, so the job asks again. */
const UNSETTLED = new Set(['TIMEOUT', 'INTERNAL']);

const UNFINISHED = 'The platform could not finish this landing; its next event tries again';

/** Leaves why on the Landing, which stays open. */
const failed = (ctx: RepoContext, number: number, head: string, code: string, message: string) =>
  ctx.call({ op: 'repo_land_clearance', number, failed: { head, code, message } });

/** Asks CTC about the Landing and lands it if cleared. The authority records what it decides;
 * the head goes in `tried`, for the job's last word. */
async function attempt(ctx: RepoContext, number: number, tried: { head?: string }) {
  const asked = await ctx.call({ op: 'repo_land_clearance', number });
  // Decided and recorded: only a head that would land goes on.
  if (asked.confirm !== true) return;
  const head: string = asked.commit;
  tried.head = head;
  try {
    // A fork's pushes reach the parent when someone looks. Moving the mirror is a new head, which
    // asks for its own job; this one has nothing left to land.
    if (asked.source_repo) {
      const change = { ...asked, status: 'open', head };
      if (await followForkChange(ctx.env, ctx.repo, change)) return;
    }
    const judged = await ctx.call({ op: 'repo_land_clearance', number, confirm: true });
    if (judged.state !== 'cleared') return;
    const guard = { clearance: number, expected_head: head };
    await landWithMerge(ctx, asked.ref, head, false, landMode(ctx.env), true, guard);
    await recordJob(ctx.env, ctx.repo, { operation: 'land', detail: 'landed' });
  } catch (e) {
    if (!(e instanceof ApiError) || UNSETTLED.has(e.code)) throw e;
    // A new head has its own turn, and this one's reason is no use to it.
    if (e.code === 'HEAD_MOVED') return;
    await failed(ctx, number, head, e.code, e.message);
    await recordJob(ctx.env, ctx.repo, {
      operation: 'land',
      detail: 'refused',
      reason: refusalReason(e),
    });
  }
}

/** The `platform_land_check` queue job, for one Landing or, after a legal hold lifted, for what
 * the hold held: the answer names those, and each gets a job of its own (repo-land-check.ts).
 * `retry`: seconds until the queue delivers it again. */
export async function landCheckJob(env: Env, envelope: Envelope, attempts: number) {
  const number = envelope.number;
  const lifted = envelope.job_id === HOLD_LIFTED;
  if (!landChecksOn(env) || (typeof number !== 'number' && !lifted)) return {};
  const repo = envelope.repo_id;
  const ctx = new RepoContext(env, repo, caller(env, repo, { _system: 'land-when-cleared' }));
  const tried: { head?: string } = {};
  try {
    if (typeof number === 'number') await attempt(ctx, number, tried);
    else await ctx.call({ op: 'repo_land_clearance', hold_lifted: true });
    return {};
  } catch (e) {
    // The repository or the Landing is gone: nothing to come back for.
    if (e instanceof ApiError && !UNSETTLED.has(e.code)) return {};
    if (attempts < ATTEMPTS) return { retry: RETRY_S * attempts };
    log.warn('land_check.gave_up', { error: e });
    if (tried.head && typeof number === 'number')
      await failed(ctx, number, tried.head, 'UNFINISHED', UNFINISHED).catch(
        warned('land_check.not_recorded', { repo: ctx.repo }),
      );
    return {};
  }
}
