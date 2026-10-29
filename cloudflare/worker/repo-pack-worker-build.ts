// The pack-build job's fallback when its container is unavailable (no PackBuilder binding,
// a container that does not start or fails, or a depth the container does not build): the
// pack built in this Worker, as a clone's is (repo-pack-build), and stored as it streams.
// Bounded by the isolate's 128 MB and the job's CPU, so the container is tried first.
import { UploadSession } from './repo-git-sessions';
import { type Json, RepoContext } from './repo-ops';
import { buildPack } from './repo-pack-build';
import { type Fresh, PART, PackWriter, packKey } from './repo-pack-cache';
import { CHUNK, logPack, PackStats, sideBand } from './repo-pack-stream';

export type WorkerOutcome = 'held' | 'small' | 'withheld' | 'stored' | 'not kept';

/** Builds and stores the pack of `fresh` (for main's `tip`, after a push) unless held or
 * reaching fewer than `minObjects` objects. */
export async function buildInWorker(
  ctx: RepoContext,
  fresh: Fresh,
  tip: string | undefined,
  label: string,
  minObjects: number,
): Promise<WorkerOutcome> {
  const { env, repo } = ctx;
  const key = await packKey(repo, fresh);
  if (await env.OBJECTS.head(key)) return 'held';
  const objects = await ctx.objects();
  const walked = await ctx.call({
    op: 'repo_git_walk',
    wants: fresh.wants,
    haves: [],
    objects: true,
    shallows: [],
    depth: fresh.depth,
    deepen_relative: fresh.deepen_relative,
  });
  const commits = (walked.commits as Json[]).map((c) => String(c.commit));
  const stats = new PackStats(false);
  const session = UploadSession.open({ ...walked, omit_blobs: fresh.omit_blobs });
  const built = await buildPack(session, objects, commits, stats);
  if (built.count < minObjects) {
    built.close();
    return 'small';
  }
  const writer = new PackWriter(env, repo, key, PART, tip);
  let outcome: WorkerOutcome;
  try {
    for await (const chunk of built.chunks) await writer.add(sideBand(1, chunk, CHUNK));
    // A blob withheld while the pack was built: the pack is not kept.
    const now = new RepoContext(env, repo, ctx.call);
    if (await (await now.objects()).withholdsAny()) {
      await writer.abort();
      return 'withheld';
    }
    outcome = (await writer.finish(0)) ? 'stored' : 'not kept';
  } catch (e) {
    await writer.abort().catch(() => {});
    throw e;
  }
  logPack('git.pack.build', repo, stats, {
    builder: 'worker',
    label,
    objects: built.count,
    outcome,
  });
  return outcome;
}
