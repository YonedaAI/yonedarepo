// LFS objects a fork inherits. A fork's download batch names its parent (repo_store/lfs.rs);
// objects the fork does not store are asked of the parent's authority, then of its parent,
// each time with the caller's own credentials, so the parent decides with its current
// access (read on the whole parent, as for the fork's other inherited objects in
// repo-inherit.ts). Only objects an ancestor answers as stored are served, from that
// ancestor's key; a caller it refuses gets a 404 naming the read it lacks and no URL.
// Nothing is copied into the fork, so its quota counts its own uploads only.
import { REFUSED } from './repo-inherit';
import { type Credentials, caller, type Json, type RepoContext } from './repo-ops';

/** Fork chains are short; this bounds a malformed one. */
const MAX_DEPTH = 8;

/** Marks each object of `decided` (a download batch of a fork) that an ancestor stores with
 * `holder`, that ancestor's id; the rest keep their 404, explained when access was refused. */
export async function inheritObjects(ctx: RepoContext, decided: Json) {
  const objects = decided.objects as Json[];
  let missing = objects.filter((o) => o.error?.code === 404);
  let repo: string | null = decided.parent ?? null;
  const auth = ctx.call.sign({}) as Credentials;
  for (let depth = 0; repo && missing.length > 0 && depth < MAX_DEPTH; depth++) {
    let answer: Json;
    try {
      answer = await caller(
        ctx.env,
        repo,
        auth,
      )({
        op: 'repo_lfs_batch',
        operation: 'download',
        objects: missing.map(({ oid, size }) => ({ oid, size })),
      });
    } catch (e: any) {
      if (!REFUSED.includes(e?.code)) throw e;
      const message = `Objects this fork inherits need read on its parent repository ${repo}`;
      for (const o of missing) o.error = { code: 404, message };
      return;
    }
    const answered = answer.objects as Json[];
    const next: Json[] = [];
    missing.forEach((o, i) => {
      const held = answered[i];
      if (held?.present && held.oid === o.oid && held.size === o.size) {
        delete o.error;
        Object.assign(o, { present: true, holder: repo });
      } else next.push(o);
    });
    missing = next;
    repo = answer.parent ?? null;
  }
}
