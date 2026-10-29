// Pack-build jobs (platform queue, `platform_pack_build`): clone packs (repo-pack-cache)
// built with no client waiting, in the repository's PackBuilder container (platform-pack-builder.ts:
// stock Git, real deltas, up to 1 GiB) rather than a 128 MB Worker isolate; in this Worker
// only when the container is unavailable (repo-pack-worker-build). Two ways in:
// - `asked-<name>`: a clone that could not store its pack (its isolate's Wasm too high, or
//   the store fell behind the clone) hands its fetch over (`handOff`). The fetch is written
//   beside the pack's key (`<name>.request`, only when absent: concurrent clones queue one
//   job; a request older than STALE_MS counts as lost) and the job builds that pack.
// - `push-<tip>`: after main moves (the derive job), main's clone packs are built for its
//   tip DEBOUNCE_S later: full, blob:none and depth 1, in one container start. A job whose
//   tip main has since left settles with nothing (the later push's job builds), so a burst
//   of pushes builds once, for its last tip; packs of an earlier tip are deleted once a
//   later tip's are stored (PackWriter).
// One build at a time per repository: a lease in R2 (`building`, written only when absent or
// expired); a job that finds it held comes back BUSY_S later. A repository whose wants
// reach fewer than PACK_BUILD_MIN_OBJECTS objects is not built for (its clones build
// quickly). No pack is kept while the repository withholds any blob (checked before the
// build and before each pack is kept). Every build logs `git.pack.build`: the container's
// start, fetch and per-pack wall and CPU ms, peak memory, objects and bytes (a Worker
// build: its wall and read-wait ms and Wasm MiB).
import { failureCode } from './durable';
import { type BuildPlan, canBuild, type PackOrder, packBuilder } from './platform-pack-builder';
import { caller, type Json, RepoContext } from './repo-ops';
import { type Fresh, packCacheOn, packKey, packsPrefix } from './repo-pack-cache';
import { buildInWorker } from './repo-pack-worker-build';
import type { Env, Envelope } from './types';

export const PACK_BUILD = 'platform_pack_build';
/** A push to main is built for this long after it, unless main moved again meanwhile. */
export const DEBOUNCE_S = 60;
/** A job finding another build running comes back this much later. */
const BUSY_S = 60;
/** A build's lease (a queue job runs 15 minutes at most). */
const LEASE_MS = 20 * 60_000;
/** A handed-over fetch whose job has not settled after this long is taken as lost. */
const STALE_MS = 30 * 60_000;
const MAIN = 'refs/heads/main';

/** Objects a pack needs before a job builds it (PACK_BUILD_MIN_OBJECTS, default 5,000). */
export const minObjects = (env: Env) => Number(env.PACK_BUILD_MIN_OBJECTS ?? 5_000);

/** Main's packs a job builds after a push: what a clone, a partial clone and a shallow
 * clone (single branch) ask for. */
const tipPacks = (wants: string[], tip: string): PackOrder[] => [
  { label: 'full', tip, fresh: { wants, omit_blobs: false, depth: null, deepen_relative: false } },
  {
    label: 'partial',
    tip,
    fresh: { wants, omit_blobs: true, depth: null, deepen_relative: false },
  },
  {
    label: 'shallow',
    tip,
    fresh: { wants: [tip], omit_blobs: false, depth: 1, deepen_relative: false },
  },
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
  await env.PLATFORM_QUEUE.send(job(repo, `push-${tip}`), { delaySeconds: DEBOUNCE_S });
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
    const built = await leased(env, envelope, () =>
      build(ctx, [{ label: 'asked', fresh }], envelope.job_id),
    );
    if (built !== 'busy') await env.OBJECTS.delete(requestKey(key));
    return;
  }
  if (way !== 'push') return;
  const tip = rest[0];
  const listed = await ctx.call({ op: 'repo_refs' });
  if (listed.refs[MAIN] !== tip) return void log({ repo, outcome: 'superseded', tip });
  await leased(env, envelope, () => build(ctx, tipPacks(cloneWants(listed), tip), envelope.job_id));
}

/** What `git clone` wants: every branch and tag (an annotated tag's object, not its
 * commit; HEAD is main's commit). */
function cloneWants({ refs, annotated }: Json): string[] {
  const names = Object.keys(refs).filter(
    (name) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'),
  );
  return [...new Set(names.map((name) => String(annotated?.[name] ?? refs[name])))];
}

/** `work` under the repository's build lease; without it, the job comes back later. */
async function leased(env: Env, envelope: Envelope, work: () => Promise<unknown>) {
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

/** Builds `packs` in the repository's container, or in this Worker when the container is
 * unavailable, unless a blob is withheld. */
async function build(ctx: RepoContext, packs: PackOrder[], job: string) {
  const { env, repo } = ctx;
  if (await (await ctx.objects()).withholdsAny()) return log({ repo, job, outcome: 'withheld' });
  const plan: BuildPlan = { repo, packs, minObjects: minObjects(env) };
  const builder = packBuilder(env, repo);
  let why = 'no builder';
  if (builder && packs.every((p) => canBuild(p.fresh))) {
    const started = Date.now();
    try {
      const report = await builder.build(plan);
      return log({ repo, job, builder: 'container', ms: Date.now() - started, ...report });
    } catch (e) {
      why = String((e as Error)?.message ?? e).slice(0, 300);
    }
  } else if (builder) why = 'a depth the container does not build';
  log({ repo, job, outcome: 'container unavailable', why });
  for (const { fresh, tip, label } of packs)
    if ((await buildInWorker(ctx, fresh, tip, label, plan.minObjects)) === 'small') break;
}

function log(fields: Json) {
  console.log(JSON.stringify({ event: 'git.pack.build', ...fields }));
}
