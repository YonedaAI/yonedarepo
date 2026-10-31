// The Home's activity row (D1 `platform_activity`): marked touched when a ref moves or a
// session is recorded, so the next account view re-reads that repository's authority
// (platform-account-activity.ts). The same write carries the database size when the derive
// job has a fresh sample, so sampling adds no D1 write (repo-storage.ts).
import { logCrossings } from './repo-storage';
import type { Env } from './types';

/** The touch with a size: the size it replaces, read in the same transaction, tells whether a
 * level was crossed, however many isolates sample. */
async function touchWithSize(env: Env, repo: string, now: number, dbBytes: number) {
  const [before] = await env.INDEX.batch<{ db_bytes: number | null }>([
    env.INDEX.prepare('SELECT db_bytes FROM platform_activity WHERE repo=?').bind(repo),
    env.INDEX.prepare(
      `INSERT INTO platform_activity(repo,touched_at,db_bytes) VALUES(?1,?2,?3)
         ON CONFLICT(repo) DO UPDATE SET touched_at=MAX(touched_at,?2),db_bytes=?3`,
    ).bind(repo, now, dbBytes),
  ]);
  logCrossings(repo, before.results[0]?.db_bytes ?? 0, dbBytes);
}

/** A ref moved or a session was recorded: the next Home view re-reads the repository.
 * Never throws (the row only feeds the Home and the admin pages). */
export async function touchActivity(env: Env, repo: string, now = Date.now(), dbBytes?: number) {
  try {
    if (dbBytes !== undefined) return await touchWithSize(env, repo, now, dbBytes);
    await env.INDEX.prepare(
      `INSERT INTO platform_activity(repo,touched_at) VALUES(?1,?2)
         ON CONFLICT(repo) DO UPDATE SET touched_at=MAX(touched_at,?2)`,
    )
      .bind(repo, now)
      .run();
  } catch (e: any) {
    console.warn(`activity touch failed: ${e?.message ?? e}`);
  }
}
