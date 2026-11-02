// Filling in who wrote commits recorded before `commits` kept it, a page at a time, from their
// Git objects (`cargo xtask admin author-backfill`). Repeating it fills nothing twice, and a
// commit whose object has gone stays empty. repo_store/commit_authors.rs checks the bytes.

import { audit } from './platform-admin-queries';
import { RepoObjects } from './repo-objects';
import { caller, type Json } from './repo-ops';
import { parseStore } from './repo-stores';
import type { Env } from './types';

/** `POST /admin/repos/<id>/author-backfill {after?, dry_run?}`: one page. `next`: where the next
 * starts, none when this was the last. */
export async function authorBackfill(env: Env, actor: string, repo: string, body: Json) {
  const call = caller(env, repo, { _system: 'import' });
  const after = typeof body.after === 'string' ? body.after : '';
  const page = await call({ op: 'repo_authors_missing', after });
  const ids = page.commits as string[];
  if (body.dry_run === true || ids.length === 0)
    return { missing: ids.length, filled: 0, unreadable: 0, next: page.next };
  const { object_store } = await call({ op: 'repo_status' });
  const objects = new RepoObjects(env, repo, parseStore(env, String(object_store)));
  const found = await objects.raw(ids.map((id) => ({ id, kind: 'commit' })));
  const commits = found.map((o) => ({ commit: o.id, data_b64: o.data_b64 }));
  const { filled } = await call({ op: 'repo_authors_set', commits });
  if (filled > 0) await audit(env, actor, 'repo.author_backfill', repo, { filled });
  return { missing: ids.length, filled, unreadable: ids.length - found.length, next: page.next };
}
