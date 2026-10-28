// Log compaction (repo_store/maintenance/compaction.rs): keeps the authority's SQL log a
// bounded tail. The authority decides what is due and seals it; this adapter only writes
// the two objects to R2, reads them back byte for byte, and reports back, after which the
// authority deletes those rows in one transaction. No network I/O happens inside it, and
// a run that dies at any step is simply run again (the plan reseals the same bytes).
import { archiveKey } from './repo-archive';
import { changeLogHold } from './repo-changelog';
import { ApiError, type Call, caller, type Json } from './repo-ops';
import type { Env } from './types';

/** Versions per segment (SEGMENT_VERSIONS in yoneda-core): nothing is due below it. */
const SEGMENT_VERSIONS = 1024;
/** Segments one run moves at most; the next run continues. */
const SEGMENTS_PER_RUN = 8;
/** One background check per repository per isolate in this window. */
const CHECK_EVERY_MS = 60_000;

async function writeVerified(env: Env, repo: string, sealed: Json) {
  const key = archiveKey(repo, sealed.key);
  await env.OBJECTS.put(key, sealed.body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { digest: sealed.digest },
  });
  const back = await env.OBJECTS.get(key);
  if ((await back?.text()) !== sealed.body)
    throw new ApiError('ARCHIVE_READBACK', `${sealed.key} did not read back as written`);
}

/** Moves due segments (at most `max`) through `call`; answers the floor and tail size. */
export async function compactLog(env: Env, repo: string, call: Call, max = SEGMENTS_PER_RUN) {
  // A change-log stream still reading older versions holds them in SQL.
  const hold = await changeLogHold(env, repo);
  const held = hold === undefined ? {} : { hold };
  let last: Json = {};
  let segments = 0;
  while (segments < max) {
    const plan = await call({ op: 'repo_compact_plan', ...held });
    last = plan;
    if (!plan.due) break;
    await writeVerified(env, repo, plan.segment);
    await writeVerified(env, repo, plan.checkpoints);
    last = await call({
      op: 'repo_compact_done',
      start: plan.start,
      end: plan.end,
      segment_digest: plan.segment.digest,
      checkpoints_digest: plan.checkpoints.digest,
      ...held,
    });
    segments++;
  }
  const { floor, head, tail_rows, retention } = last;
  return { segments, floor, head, tail_rows, retention, more: segments === max };
}

const checked = new Map<string, number>();

/** After a landing (derive job): compacts when the log may hold a due segment. Never
 * throws; a failure is logged and the next landing's job tries again. */
export async function compactAfterLanding(env: Env, repo: string, version: number) {
  if (!(version > SEGMENT_VERSIONS) || (checked.get(repo) ?? 0) > Date.now() - CHECK_EVERY_MS)
    return null;
  checked.set(repo, Date.now());
  try {
    return await compactLog(env, repo, caller(env, repo, { _system: 'compact' }), 4);
  } catch (e: any) {
    const code = e instanceof ApiError ? e.code : 'COMPACTION';
    console.error(
      JSON.stringify({
        event: 'compaction.failed',
        repo,
        code,
        message: String(e?.message ?? e).slice(0, 200),
      }),
    );
    return null;
  }
}
