// The clearance job: lands an open Landing once its exact head has cleared, for a repository
// with the switch on. The authority decides (repo_store/land_when_cleared.rs); this carries out
// what only an adapter can: a fork's newest head, the Risk of the head's diff, and the landing,
// which names the head it evaluated so a newer push can't slip in. The platform evaluates rules
// and moves a ref; it starts no agent. A refused or conflicted landing leaves the Landing open
// with its reason, and only the next trigger tries again. Queues deliver at least once: a
// duplicate finds the Landing landed, or shares its queue ticket.
import { landMode } from './repo-changesets';
import { followForkChange } from './repo-forks';
import { changeInstruments } from './repo-instruments';
import { landChecksOn } from './repo-land-check';
import { landWithMerge } from './repo-landing';
import { ApiError, caller, type Json, RepoContext } from './repo-ops';
import type { Env, Envelope } from './types';

/** Tries of one job for an answer that says nothing about the Landing itself. */
const ATTEMPTS = 3;
const RETRY_S = 30;
/** Not an answer about the Landing: the ticket may still land, so the job asks again. */
const UNSETTLED = new Set(['TIMEOUT', 'INTERNAL']);

const UNFINISHED = 'The platform could not finish this landing; its next event tries again';

type Refuse = (code: string, message: string) => Promise<unknown>;

/** Leaves why on the Landing, which stays open. */
const failed = (ctx: RepoContext, number: number, head: string, code: string, message: string) =>
  ctx.call({ op: 'repo_land_clearance', number, failed: { head, code, message } });

/** Whether Risk holds the head: High, or not known. Conservative, and the owner can see why. */
async function riskRefused(ctx: RepoContext, number: number, head: string, refuse: Refuse) {
  const newest = (await changeInstruments(ctx, number)).heads?.[0];
  // The head moved since the clearance: that move asked for its own job.
  if (newest?.commit !== head) return true;
  const risk = newest.risk;
  if (risk?.level === 'low' || risk?.level === 'medium') return false;
  if (!risk) await refuse('RISK_UNKNOWN', 'Risk could not be scored for this head');
  else {
    const why = (risk.reasons as Json[]).filter((r) => r.points > 0).map((r) => r.why);
    await refuse('RISK_HIGH', `Risk is High (${risk.score}): ${why.join('; ')}`);
  }
  return true;
}

/** Tries to land the Landing; the head it evaluated goes in `tried`, for the job's last word. */
async function attempt(ctx: RepoContext, number: number, tried: { head?: string }) {
  const answer = await ctx.call({ op: 'repo_land_clearance', number });
  if (answer.state !== 'cleared') return;
  const head: string = answer.commit;
  tried.head = head;
  const refuse: Refuse = (code, message) => failed(ctx, number, head, code, message);
  try {
    // A fork's pushes reach the parent when someone looks. Moving the mirror is a new head, which
    // asks for its own job; this one has nothing left to land.
    if (answer.source_repo) {
      const change = { ...answer, status: 'open', head };
      if (await followForkChange(ctx.env, ctx.repo, change)) return;
    }
    if (await riskRefused(ctx, number, head, refuse)) return;
    const guard = { clearance: number, expected_head: head };
    await landWithMerge(ctx, answer.ref, head, false, landMode(ctx.env), true, guard);
  } catch (e) {
    if (!(e instanceof ApiError) || UNSETTLED.has(e.code)) throw e;
    // A new head has its own turn, and this one's reason is no use to it.
    if (e.code !== 'HEAD_MOVED') await refuse(e.code, e.message);
  }
}

/** The `platform_land_check` queue job. `retry`: seconds until the queue delivers it again. */
export async function landCheckJob(env: Env, envelope: Envelope, attempts: number) {
  const number = envelope.number;
  if (!landChecksOn(env) || typeof number !== 'number') return {};
  const repo = envelope.repo_id;
  const ctx = new RepoContext(env, repo, caller(env, repo, { _system: 'land-when-cleared' }));
  const tried: { head?: string } = {};
  try {
    await attempt(ctx, number, tried);
    return {};
  } catch (e) {
    // The repository or the Landing is gone: nothing to come back for.
    if (e instanceof ApiError && !UNSETTLED.has(e.code)) return {};
    if (attempts < ATTEMPTS) return { retry: RETRY_S * attempts };
    console.warn(`land check gave up: ${(e as Error)?.message ?? e}`);
    if (tried.head) await failed(ctx, number, tried.head, 'UNFINISHED', UNFINISHED).catch(() => {});
    return {};
  }
}
