// What asks for a clearance job (repo-land-cleared.ts). The authority names the Landings an op
// may have cleared in the op's answer (`land_checks`, repo_store/land_when_cleared/triggers.rs),
// and every answer passes here, so no route has to remember. A lost message costs that Landing
// this trigger, not the next: the job is only ever a request to look again. A legal hold is the
// one thing that lifts outside the repository, so its release sends the job here itself.
//
// `platform_land_check` must be known to every Worker on the queue before one is sent, since an
// unknown kind is acked and dropped (platform-entrypoint.ts). So `LAND_WHEN_CLEARED` stays off
// through the deploy that ships the handler and goes on in a later one (docs/runbook.md); a
// rollback past the handler drops messages, which waits for the next trigger and loses nothing.

import { log } from './log';
import { carriedQueue } from './request-scope';
import type { Env, Json } from './types';

export const LAND_CHECK = 'platform_land_check';
/** A job naming no Landing: the hold on this repository lifted, so it finds what the hold held. */
export const HOLD_LIFTED = 'hold-lifted';
/** Repositories asked at once: a queue batch's limit. */
const REPOS_PAGE = 100;

export const landChecksOn = (env: Env) => env.LAND_WHEN_CLEARED === 'on';

/** Takes `land_checks` off `answer`, which clients never see, and sends one job per Landing. */
export async function sendLandChecks(env: Env, repo: string, answer: Json) {
  const numbers: number[] | undefined = answer?.land_checks;
  if (!numbers) return;
  delete answer.land_checks;
  if (!landChecksOn(env)) return;
  const jobs = numbers.map((number) => ({
    body: { v: 1 as const, kind: LAND_CHECK, repo_id: repo, job_id: String(number), number },
  }));
  // The op committed: this can't fail it.
  await carriedQueue(env.PLATFORM_QUEUE)
    .sendBatch(jobs)
    .catch((e: Error) => log.warn('land_check.dispatch_failed', { error: e }));
}

/** After a hold lifted, on `repo` or on all `owner` has. Any other layer still standing just holds
 * its Landings again. The release committed: this can't fail it. */
export async function sendHoldLifted(env: Env, owner: string, repo?: string) {
  if (!landChecksOn(env)) return;
  const send = (ids: string[]) =>
    carriedQueue(env.PLATFORM_QUEUE).sendBatch(
      ids.map((id) => ({
        body: { v: 1 as const, kind: LAND_CHECK, repo_id: id, job_id: HOLD_LIFTED },
      })),
    );
  try {
    if (repo) return await send([repo]);
    const page = env.INDEX.prepare(
      'SELECT id FROM platform_repos WHERE workspace=? AND id>? ORDER BY id LIMIT ?',
    );
    for (let after = ''; ; ) {
      const { results } = await page.bind(owner, after, REPOS_PAGE).all<{ id: string }>();
      if (results.length) await send(results.map(({ id }) => id));
      if (results.length < REPOS_PAGE) return;
      after = results[results.length - 1].id;
    }
  } catch (e) {
    log.warn('land_check.dispatch_failed', { error: e });
  }
}
