// What a fork inherits: its object store spec names the parent's (repo-stores `forkSpec`),
// and reads its own tiers miss fall back to the parent's (repo-objects). Nothing is copied,
// and nothing inherited is cached under the fork's keys. The fork's authority bounds what
// that reaches: its graph holds only what the parent's refs reached at the fork, Git
// fetches must be reachable from its refs, and file reads start at its refs or commits
// (forks.rs). Where a caller names object ids itself (`POST /objects`) or a push relies on
// objects it omitted, `guardInherited` requires current read on the parent as well.
import { cachedCopy } from './repo-cache-tiers';
import type { ObjectKind, RepoObjects } from './repo-objects';
import { ApiError, type Credentials, caller, type RepoContext } from './repo-ops';
import type { RawObject } from './repo-stores';

/** A fork's parent objects, and the check this request must pass to be served them. */
export class Inherited {
  private checked?: Promise<void>;
  /** Set per request by `guardInherited`; none: reads reachable by construction. */
  guard?: () => Promise<void>;
  constructor(readonly parent: RepoObjects) {}
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

const REFUSED = ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'GONE'];

/**
 * Serves `objects`' inherited objects to this request only if its caller can read the
 * whole parent now (a platform job always can): asked once, of the parent's authority,
 * with the caller's own credentials.
 */
export function guardInherited(ctx: RepoContext, objects: RepoObjects) {
  const inherited = objects.inherited;
  const auth = ctx.call.sign({}) as Credentials;
  if (!inherited || '_system' in auth) return;
  inherited.guard = async () => {
    try {
      await caller(
        ctx.env,
        inherited.parent.repo,
        auth,
      )({
        op: 'repo_git_access',
        service: 'git-upload-pack',
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
