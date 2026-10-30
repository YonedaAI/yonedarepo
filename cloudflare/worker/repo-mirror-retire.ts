// Retiring a repository's Artifacts mirror after a purge: the quarantine job's part (the
// authority requests, leases and fences it: repo_store/quarantine/mirror.rs). Artifacts
// deletes only whole repositories, so a purged blob leaves the mirror only with the mirror,
// and the mirror may hold history nothing else does (imported history, commits pushed
// before R2 was the store of record, large API commits). In order, each step repeatable and
// recorded by the authority before the next starts:
// 1. copy: what the mirror's refs reach is fetched from the mirror a wave at a time (Git
//    upload-pack, the pack streamed into the store of record: repo-pack-copy), withheld
//    blobs never written; each wave's wants are then recorded as copied and serve as the
//    next waves' haves. A long first-parent history is taken WAVE commits at a time (the
//    mirror's log names them), so no pack outgrows what a session holds (64 MiB).
// 2. verify: a fresh listing of the mirror's refs has every tip copied, and each tip's
//    commit reads back from the store of record. Then `switch`: the replacement takes the
//    mirror's place and nothing projects to it again.
// 3. once every isolate's copy of the old store has expired, the Artifacts repository is
//    deleted (already gone counts), and `retired` closes the retirement.
// Reads keep working throughout: from the mirror until the switch, from the store of record
// after it (a store still naming the deleted mirror finds nothing there and reads on).
import { noteBundles } from './repo-bundles';
import { accessEverywhere } from './repo-head';
import {
  advertised,
  fetchPack,
  firstParents,
  gone,
  type Mirror,
  type MirrorRef,
  mirrorAccess,
} from './repo-mirror-git';
import { RepoObjects } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { copyHeader, PackCopy } from './repo-pack-copy';
import { PlatformStore } from './repo-platform-store';
import { withheldMap } from './repo-quarantine-guard';
import type { Env } from './types';

/** First-parent commits one wave takes along a branch. */
const WAVE = 500;
/** Tips one wave wants at most. */
const WANTS = 64;
/** Copied commits a fetch names as haves (the latest: each one's history is copied). */
const HAVES = 256;
/** Waves one run fetches before handing on to the next run. */
const RUN_WAVES = 8;
/** A wave starts only with this much of the lease left. */
const MARGIN_MS = 5 * 60 * 1000;
/** A failed run's retirement is tried again after this long. */
const RETRY_MS = 10 * 60 * 1000;
/** The longest first-parent history a branch is walked along. */
const MAX_CHAIN = 500_000;

type Call = (command: Json) => Promise<Json>;

/** The Artifacts repository a retirement deletes: one of this deployment's namespace. */
function mirrorName(env: Env, spec: string) {
  const artifacts = /^artifacts:([^/]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
  if (!artifacts || artifacts[1] !== env.ARTIFACTS_NAMESPACE)
    throw new Error(`The mirror ${spec} is outside this deployment`);
  return artifacts[2];
}

/** Works on `repo`'s mirror retirement for one run; answers when it is next due (null:
 * nothing waits). A failure is recorded with the retirement and tried again later. */
export async function retireMirror(env: Env, repo: string): Promise<number | null> {
  const call = caller(env, repo, { _system: 'quarantine' });
  const claim = await call({ op: 'repo_mirror_claim' });
  if (claim.busy) return claim.lease_until;
  const retirement = claim.retirement;
  if (!retirement) return null;
  const { epoch } = claim;
  try {
    const name = mirrorName(env, retirement.mirror);
    if (retirement.state === 'copying') {
      const copied = new Set<string>(claim.copied);
      if (!(await copyMirror(env, repo, call, epoch, name, copied, claim.lease_until)))
        return Date.now();
      await call({ op: 'repo_mirror_switch', epoch });
    }
    await accessEverywhere(env, repo);
    await env.ARTIFACTS.delete(name).catch((e: any) => {
      if (!gone(e)) throw e;
    });
    await call({ op: 'repo_mirror_retired', epoch });
    return null;
  } catch (e: any) {
    // Claimed again by a run that carries on (this one's lease ran out).
    if (e?.code === 'CONFLICT') return null;
    const detail = `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 400)}`;
    console.warn(`mirror retirement of ${repo} stopped: ${detail}`);
    await call({ op: 'repo_mirror_failed', epoch, detail }).catch(() => {});
    return Date.now() + RETRY_MS;
  }
}

/** Copies what the mirror holds into the store of record, a wave at a time; answers
 * whether it is all there (verified), or false when the next run carries on. */
async function copyMirror(
  env: Env,
  repo: string,
  call: Call,
  epoch: number,
  name: string,
  copied: Set<string>,
  leaseUntil: number,
) {
  const status = await call({ op: 'repo_status' });
  if (status.bundled) noteBundles(repo);
  const withheld = new Set(withheldMap(status.quarantined).keys());
  const mirror = await mirrorAccess(env, name);
  let along = true;
  for (let waves = 0; ; ) {
    const refs = await advertised(mirror);
    const plan = await planWaves(env, name, refs, copied, along);
    if (plan.length === 0) return verify(env, repo, refs);
    for (const { wants, tips } of plan) {
      if (waves++ >= RUN_WAVES || leaseUntil - Date.now() < MARGIN_MS) return false;
      try {
        await copyWave(env, repo, mirror, wants, [...copied].slice(-HAVES), withheld);
      } catch (e: any) {
        // A server that serves only advertised tips: whole branches, then.
        if (tips || !/not our ref|unadvertised|not valid/i.test(String(e?.message))) throw e;
        along = false;
        break;
      }
      await call({ op: 'repo_mirror_copied', epoch, commits: wants });
      for (const id of wants) copied.add(id);
    }
  }
}

/** The waves that copy every tip not copied yet, in order: `along` each branch or tag, a
 * wave per WAVE first-parent commits not copied (wanting commits no ref names), then the
 * tips WANTS at a time. */
async function planWaves(
  env: Env,
  name: string,
  refs: MirrorRef[],
  copied: Set<string>,
  along: boolean,
) {
  const named = (r: MirrorRef) => /^refs\/(heads|tags)\//.test(r.name);
  const tips = [...new Set([...refs.filter(named), ...refs].map((r) => r.id))].filter(
    (id) => !copied.has(id),
  );
  const waves: { wants: string[]; tips: boolean }[] = [];
  for (const ref of along ? refs.filter((r) => named(r) && !copied.has(r.id)) : []) {
    const chain = await firstParents(env, name, ref.peeled ?? ref.id, copied, MAX_CHAIN);
    // Oldest first: the commit WAVE above what is copied, then WAVE above that.
    for (let at = chain.length - WAVE; at > 0; at -= WAVE)
      waves.push({ wants: [chain[at]], tips: false });
  }
  for (let i = 0; i < tips.length; i += WANTS)
    waves.push({ wants: tips.slice(i, i + WANTS), tips: true });
  return waves;
}

/** One wave: the pack of what `wants` reach beyond `haves`, into the store of record. */
async function copyWave(
  env: Env,
  repo: string,
  mirror: Mirror,
  wants: string[],
  haves: string[],
  withheld: ReadonlySet<string>,
) {
  const objects = new RepoObjects(env, repo, new PlatformStore(env, repo));
  const copy = new PackCopy(env, repo, (id) => objects.rawKey(id), withheld);
  try {
    await copy.feed(copyHeader(wants[0]));
    for await (const bytes of fetchPack(mirror, wants, haves)) await copy.feed(bytes);
    await copy.store();
  } finally {
    await copy.close();
  }
}

/** Every tip's commit reads back from the store of record. */
async function verify(env: Env, repo: string, refs: MirrorRef[]) {
  const objects = new RepoObjects(env, repo, new PlatformStore(env, repo));
  const commits = [...new Set(refs.map((r) => r.peeled ?? r.id))];
  for (let i = 0; i < commits.length; i += 500) {
    const chunk = commits.slice(i, i + 500).map((id) => ({ id, kind: 'commit' }));
    const found = await objects.stored(chunk);
    if (found.length < chunk.length)
      throw new Error(
        `${chunk.length - found.length} of the mirror's commits are not in the store of record`,
      );
  }
  return true;
}
