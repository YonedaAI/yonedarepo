// The Home's activity row (D1 `platform_activity`): marked touched when a ref moves or a
// session is recorded, so the next account view re-reads that repository's authority
// (platform-account-activity.ts).
import type { Env } from './types';

/** A ref moved or a session was recorded: the next Home view re-reads the repository.
 * Never throws (the row only feeds the Home). */
export async function touchActivity(env: Env, repo: string, now = Date.now()) {
  await env.INDEX.prepare(
    `INSERT INTO platform_activity(repo,touched_at) VALUES(?1,?2)
       ON CONFLICT(repo) DO UPDATE SET touched_at=MAX(touched_at,?2)`,
  )
    .bind(repo, now)
    .run()
    .catch((e) => console.warn(`activity touch failed: ${e?.message ?? e}`));
}
