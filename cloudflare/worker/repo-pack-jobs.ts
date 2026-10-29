// Pack-build jobs (platform queue, `platform_pack_build`): a clone's stored pack
// (repo-pack-cache) built with no client waiting. Two ways in:
// - `asked-<name>`: a clone that could not store its pack (its isolate's Wasm too high, or
//   the store fell behind the clone) hands its fetch over (`handOff`). The fetch is written
//   beside the pack's key (`<name>.request`, only when absent: concurrent clones queue one
//   job; a request older than STALE_MS counts as lost) and the job stores that pack.
// - `push-<step>-<tip>`: after main moves (the derive job), main's clone packs are built for
//   its tip DEBOUNCE_S later: full (step 0), blob:none (1), depth 1 (2), one per invocation,
//   each queuing the next. A job whose tip main has since left settles with nothing (the
//   later push's job builds), so a burst of pushes builds once, for its last tip; packs of
//   an earlier tip are deleted once a later tip's are stored (PackWriter).
// One build at a time per repository: a lease in R2 (`building`, written only when absent or
// expired); a job that finds it held comes back BUSY_S later. A repository with fewer than
// PACK_BUILD_MIN_OBJECTS objects in a pack is not built for (its clones build quickly).
// No pack is stored while the repository withholds any blob (checked before and after).
// Every build logs `git.pack.build` (objects, sent MiB, wall and read-wait ms, Wasm MiB);
// its CPU is the queue invocation's in the tail (one pack per message).
import { failureCode } from './durable';
import { UploadSession } from './repo-git-sessions';
import { caller, type Json, RepoContext } from './repo-ops';
import { buildPack } from './repo-pack-build';
import { type Fresh, PART, PackWriter, packCacheOn, packKey, packsPrefix } from './repo-pack-cache';
import { CHUNK, logPack, PackStats, sideBand } from './repo-pack-stream';
import type { Env, Envelope } from './types';

export const PACK_BUILD = 'platform_pack_build';
/** A push to main is built for this long after it, unless main moved again meanwhile. */
export const DEBOUNCE_S = 60;
/** A job finding another build running comes back this much later. */
const BUSY_S = 60;
/** A build's lease (a pack streams for 15 minutes at most: repo-pack-build PACK_MS). */
const LEASE_MS = 20 * 60_000;
/** A handed-over fetch whose job has not settled after this long is taken as lost. */
const STALE_MS = 30 * 60_000;
const MAIN = 'refs/heads/main';

/** Objects a pack needs before a job builds it (PACK_BUILD_MIN_OBJECTS, default 5,000). */
export const minObjects = (env: Env) => Number(env.PACK_BUILD_MIN_OBJECTS ?? 5_000);

/** Main's packs a job builds after a push, in order: what a clone, a partial clone and a
 * shallow clone (single branch) ask for. */
const TIP_PACKS: ((wants: string[], tip: string) => Fresh)[] = [
  (wants) => ({ wants, omit_blobs: false, depth: null, deepen_relative: false }),
  (wants) => ({ wants, omit_blobs: true, depth: null, deepen_relative: false }),
  (_, tip) => ({ wants: [tip], omit_blobs: false, depth: 1, deepen_relative: false }),
];

const job = (repo: string, id: string): Envelope => ({
  v: 1,
  kind: PACK_BUILD,
  repo_id: repo,
  job_id: id,
});
const requestKey = (key: string) => key.replace(/\.pack$/, '.request');
const leaseKey = (repo: string) => `${packsPrefix(repo)}building`;

/** After main moved to `tip`: its packs are built DEBOUNCE_S later. */
export async function schedulePackBuild(env: Env, repo: string, tip: string) {
  if (!packCacheOn(env)) return;
  await env.PLATFORM_QUEUE.send(job(repo, `push-0-${tip}`), { delaySeconds: DEBOUNCE_S });
}

/** A clone hands `fresh` to a job; false when one is on its way already. */
export async function handOff(env: Env, repo: string, fresh: Fresh) {
  const key = await packKey(repo, fresh);
  const body = JSON.stringify(fresh);
  let made = await env.OBJECTS.put(requestKey(key), body, { onlyIf: { etagDoesNotMatch: '*' } });
  if (!made) {
    const held = await env.OBJECTS.head(requestKey(key));
    if (held && Date.now() - held.uploaded.getTime() < STALE_MS) return false;
    const onlyIf = held ? { etagMatches: held.etag } : { etagDoesNotMatch: '*' };
    made = await env.OBJECTS.put(requestKey(key), body, { onlyIf });
    if (!made) return false;
  }
  const name = key.slice(packsPrefix(repo).length, -'.pack'.length);
  await env.PLATFORM_QUEUE.send(job(repo, `asked-${name}`));
  return true;
}

/** The queue job. A deleted repository's ends quietly. */
export async function packBuildJob(env: Env, envelope: Envelope) {
  try {
    await runJob(env, envelope);
  } catch (e) {
    if (!['GONE', 'NOT_FOUND'].includes(failureCode(e))) throw e;
    console.warn(`pack build settled: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

async function runJob(env: Env, envelope: Envelope) {
  const repo = envelope.repo_id;
  const ctx = new RepoContext(env, repo, caller(env, repo, { _system: 'derive' }));
  const [way, ...rest] = envelope.job_id.split('-');
  if (way === 'asked') {
    const key = `${packsPrefix(repo)}${rest[0]}.pack`;
    const request = await env.OBJECTS.get(requestKey(key));
    if (!request) return;
    const fresh = await request.json<Fresh>();
    const built = await leased(env, envelope, () => store(ctx, fresh, undefined, 'asked'));
    if (built !== 'busy') await env.OBJECTS.delete(requestKey(key));
    return;
  }
  if (way !== 'push') return;
  const step = Number(rest[0]);
  const tip = rest[1];
  const listed = await ctx.call({ op: 'repo_refs' });
  if (listed.refs[MAIN] !== tip) return void logBuild(repo, 'superseded', { tip });
  const fresh = TIP_PACKS[step](cloneWants(listed), tip);
  const built = await leased(env, envelope, () => store(ctx, fresh, tip, `push ${step}`));
  if (built !== 'busy' && built !== 'small' && step + 1 < TIP_PACKS.length)
    await env.PLATFORM_QUEUE.send(job(repo, `push-${step + 1}-${tip}`));
}

/** What `git clone` wants: every branch and tag (an annotated tag's object, not its
 * commit; HEAD is main's commit). */
function cloneWants({ refs, annotated }: Json): string[] {
  const names = Object.keys(refs).filter(
    (name) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'),
  );
  return [...new Set(names.map((name) => String(annotated?.[name] ?? refs[name])))];
}

type Outcome = 'busy' | 'held' | 'withheld' | 'small' | 'stored' | 'not kept';

/** `work` under the repository's build lease; without it, the job comes back later. */
async function leased(env: Env, envelope: Envelope, work: () => Promise<Outcome>) {
  const etag = await lease(env, envelope.repo_id);
  if (!etag) {
    await env.PLATFORM_QUEUE.send(envelope, { delaySeconds: BUSY_S });
    return 'busy';
  }
  try {
    return await work();
  } finally {
    const held = await env.OBJECTS.head(leaseKey(envelope.repo_id));
    if (held?.etag === etag) await env.OBJECTS.delete(leaseKey(envelope.repo_id));
  }
}

/** Takes the build lease (absent, or expired), answering its etag, or null when held. */
async function lease(env: Env, repo: string) {
  const until = String(Date.now() + LEASE_MS);
  const put = (onlyIf: R2Conditional) =>
    env.OBJECTS.put(leaseKey(repo), until, { customMetadata: { until }, onlyIf });
  const made = await put({ etagDoesNotMatch: '*' });
  if (made) return made.etag;
  const held = await env.OBJECTS.head(leaseKey(repo));
  if (!held || Number(held.customMetadata?.until ?? 0) > Date.now()) return null;
  return (await put({ etagMatches: held.etag }))?.etag ?? null;
}

/** Builds and stores the pack of `fresh` (for main's `tip`, from a push) unless held. */
async function store(
  ctx: RepoContext,
  fresh: Fresh,
  tip: string | undefined,
  label: string,
): Promise<Outcome> {
  const { env, repo } = ctx;
  const objects = await ctx.objects();
  if (await objects.withholdsAny()) return logBuild(repo, 'withheld', { label });
  const key = await packKey(repo, fresh);
  if (await env.OBJECTS.head(key)) return logBuild(repo, 'held', { label });
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
  if (built.count < minObjects(env)) {
    built.close();
    return logBuild(repo, 'small', { label, objects: built.count });
  }
  const writer = new PackWriter(env, repo, key, PART, tip);
  let outcome: Outcome;
  try {
    for await (const chunk of built.chunks) await writer.add(sideBand(1, chunk, CHUNK));
    // A blob withheld while the pack was built: the pack is not kept.
    const now = new RepoContext(env, repo, ctx.call);
    if (await (await now.objects()).withholdsAny()) {
      await writer.abort();
      return logBuild(repo, 'withheld', { label });
    }
    outcome = (await writer.finish(0)) ? 'stored' : 'not kept';
  } catch (e) {
    await writer.abort().catch(() => {});
    throw e;
  }
  logPack('git.pack.build', repo, stats, { label, objects: built.count, outcome });
  return outcome;
}

/** Logs a build that stored nothing, answering its outcome. */
function logBuild<T extends Outcome | 'superseded'>(repo: string, outcome: T, extra: Json): T {
  console.log(JSON.stringify({ event: 'git.pack.build', repo, outcome, ...extra }));
  return outcome;
}
