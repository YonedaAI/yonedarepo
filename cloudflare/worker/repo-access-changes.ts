// Access and policy mutations answer only once the shared head has their new state.
import { refreshHead } from './repo-head';
import type { Json } from './repo-ops';
import type { Env } from './types';

/** Runs an access or policy change, then republishes main's head before answering (see
 * `refreshHead`): a token minted or revoked, or runners a commit must queue, hold at once. */
export async function withHeadRefresh(env: Env, repo: string, change: Promise<Json>) {
  const done = await change;
  await refreshHead(env, repo, true);
  return done;
}
