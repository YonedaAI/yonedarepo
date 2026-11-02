// What a fork inherits: its object store spec names the parent's (repo-stores `forkSpec`),
// and reads its own tiers miss fall back to the parent's (repo-objects). Nothing is copied,
// and nothing inherited is cached under the fork's keys. The fork's authority bounds what
// that reaches: its graph holds only what the parent's refs reached at the fork, Git
// fetches must be reachable from its refs, and file reads start at its refs or commits
// (forks.rs). Where a caller names object ids itself (`POST /objects`) or a push relies on
// objects it omitted, `guardInherited` requires current read on the parent as well.
import { holdsBundles, type Location, locate, type Wanted } from './repo-bundles';
import { cachedCopy } from './repo-cache-tiers';
import { ACCESS_MS, withheldOf } from './repo-head';
import type { ObjectKind, RepoObjects } from './repo-objects';
import { ApiError, type Credentials, caller, type RepoContext } from './repo-ops';
import { type Withheld, withheldMap } from './repo-quarantine-guard';
import type { RawObject } from './repo-stores';

/** A fork's parent objects, and the check this request must pass to be served them. */
export class Inherited {
  private checked?: Promise<void>;
  /** Set per request by `guardInherited`; none: reads reachable by construction. */
  guard?: () => Promise<void>;
  private parentWithheld?: { at: number; map: Promise<Withheld> };
  constructor(readonly parent: RepoObjects) {}

  /** The blobs the parent withholds (and its own parent, for a fork of a fork), from its
   * published access snapshot, read again once ACCESS_MS old like every access decision. */
  withheld(): Promise<Withheld> {
    const now = Date.now();
    if (!this.parentWithheld || now - this.parentWithheld.at >= ACCESS_MS) {
      const { env, repo } = this.parent;
      const map = Promise.all([
        withheldOf(env, repo).then(withheldMap),
        this.parent.inherited?.withheld() ?? new Map(),
      ]).then(([own, above]) => new Map([...above, ...own]));
      map.catch(() => {
        // A failed read is not kept: the next read asks again (and fails closed meanwhile).
        if (this.parentWithheld?.map === map) this.parentWithheld = undefined;
      });
      this.parentWithheld = { at: now, map };
    }
    return this.parentWithheld.map;
  }
  /** Runs this request's guard once, before the first inherited object is served. */
  check() {
    if (!this.guard) return Promise.resolve();
    this.checked ??= this.guard();
    return this.checked;
  }

  /** The parent's copy of `id`: its cached and recorded copies, or with `deep` every tier
   * it reads (authority, shards, its own parent). Never cached under the fork's keys. */
  async bytes(id: string, kind: ObjectKind, deep: boolean): Promise<Uint8Array | null> {
    const parent = this.parent;
    let bytes: Uint8Array | null;
    if (deep)
      bytes = await parent.read(id, kind).catch((e) => {
        if (e?.code === 'NOT_FOUND') return null;
        throw e;
      });
    else {
      const copy = await cachedCopy(parent.env, parent.repo, parent.key(id), id, kind);
      const raw = copy ? null : await parent.recorded(id, kind);
      bytes = copy?.bytes ?? (raw && parent.encode(raw));
    }
    if (bytes) await this.check();
    return bytes;
  }

  /** Raw content of `list` the parent holds: its store of record, or with `deep` every
   * tier of its `raw`. */
  async raw(list: { id: string; kind: string }[], deep: boolean): Promise<RawObject[]> {
    if (list.length === 0) return [];
    const got = deep ? await this.parent.raw(list) : await this.parent.stored(list);
    if (got.length) await this.check();
    return got;
  }
}

/**
 * Where bundles hold `wanted`: this repository's, then for a fork each parent's, nearest
 * first. What a fork inherits lies in its parent's bundles (every push writes them), so a
 * fork's clone reads them as the parent's own clone does; asked object by object, every
 * tier of both repositories, 39 objects cost 643 authority and shard calls and 258 R2 reads
 * against the parent's 7 and 8.
 */
export async function locateHeld(objects: RepoObjects, wanted: Wanted[]) {
  const found: Map<string, Location> = await locate(objects.env, objects.repo, wanted);
  let rest = wanted.filter((w) => !found.has(w.id));
  for (let up = objects.inherited; up && rest.length > 0; up = up.parent.inherited) {
    const { repo } = up.parent;
    const held = await locate(objects.env, repo, rest);
    if (held.size > 0) await objects.inherited?.check();
    for (const [id, place] of held) found.set(id, { ...place, repo });
    rest = rest.filter((w) => !found.has(w.id));
  }
  return found;
}

/** Whether this isolate knows bundles hold `objects`' history, its own or inherited. */
export const inBundles = (objects: RepoObjects): boolean =>
  holdsBundles(objects.repo) || (!!objects.inherited && inBundles(objects.inherited.parent));

/** Failures that mean the caller may not read the parent (not an outage). */
export const REFUSED = ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'GONE'];

/**
 * Serves `objects`' inherited objects to this request only if its caller can read the
 * whole parent now (a platform job always can, and anyone can read a public parent): asked
 * once, of the parent's authority.
 */
export function guardInherited(ctx: RepoContext, objects: RepoObjects) {
  const inherited = objects.inherited;
  const auth = ctx.call.sign({}) as Credentials;
  if (!inherited || '_system' in auth) return;
  const read = (who: Credentials) =>
    caller(
      ctx.env,
      inherited.parent.repo,
      who,
    )({
      op: 'repo_git_access',
      service: 'git-upload-pack',
    });
  inherited.guard = async () => {
    try {
      // A token of the fork alone holds nothing on the parent, yet anyone reads a public one.
      await read(auth).catch((e) => {
        if (REFUSED.includes(e?.code) && !('_anonymous' in auth)) return read({ _anonymous: true });
        throw e;
      });
    } catch (e: any) {
      if (!REFUSED.includes(e?.code)) throw e;
      throw new ApiError(
        'FORBIDDEN',
        `Objects this fork inherits need read on its parent repository ${inherited.parent.repo}`,
      );
    }
  };
}
