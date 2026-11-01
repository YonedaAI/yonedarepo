// What asks for a clearance job (repo-land-cleared.ts). The authority names the Landings an op
// may have cleared in the op's answer (`land_checks`, repo_store/land_when_cleared/triggers.rs),
// and every answer passes here, so no route has to remember. A lost message costs that Landing
// this trigger, not the next: the job is only ever a request to look again.
//
// `platform_land_check` must be known to every Worker on the queue before one is sent, since an
// unknown kind is acked and dropped (platform-entrypoint.ts). So `LAND_WHEN_CLEARED` stays off
// through the deploy that ships the handler and goes on in a later one (docs/runbook.md); a
// rollback past the handler drops messages, which waits for the next trigger and loses nothing.
import type { Env, Json } from './types';

export const LAND_CHECK = 'platform_land_check';

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
  await env.PLATFORM_QUEUE.sendBatch(jobs).catch((e: Error) =>
    console.warn(`land check dispatch failed: ${e?.message ?? e}`),
  );
}
