// What commits made through the API add to a repository's size (repo_store::capacity), so a
// push through the `yoneda::` helper counts as a Git push does. File bytes only, uncompressed:
// a commit's own object and trees come to almost nothing in a `.git` folder. They wait here
// until they amount to a megabyte, so a burst of small commits costs the authority no calls;
// what an isolate holds when it goes away isn't counted.
import { afterAnswer } from './background';
import { warned } from './log';
import type { CachedObject } from './repo-objects';
import { caller } from './repo-ops';
import type { Env } from './types';

/** Bytes held for a repository before they are reported. */
const REPORT_BYTES = 1024 * 1024;
/** Repositories this isolate holds bytes for; past this it starts over. */
const HELD_KEPT = 4096;

const held = new Map<string, number>();
const fileBytes = (objects: CachedObject[]) =>
  objects.reduce(
    (n, o) => n + (o.kind === 'blob' ? Math.floor((o.data_b64.length * 3) / 4) : 0),
    0,
  );

/** Notes `objects`, just recorded on `repo`, and reports them once there are enough. */
export function addCommitted(env: Env, repo: string, objects: CachedObject[]) {
  const bytes = (held.get(repo) ?? 0) + fileBytes(objects);
  if (bytes < REPORT_BYTES) {
    if (held.size >= HELD_KEPT) held.clear();
    held.set(repo, bytes);
    return;
  }
  held.delete(repo);
  const report = caller(env, repo, { _system: 'commits' });
  afterAnswer(() =>
    report({ op: 'repo_size_add', pack_bytes: bytes }).catch(warned('repo.size_add_failed')),
  );
}
