// Repositories whose history lived in Artifacts. Imports before they were a clone left their
// objects there, and it has gone: their commits are on record and cannot be read. `importAudit`
// finds them; `reimportRepository` empties what depended on those objects and clones again, under
// the same id and name, keeping members, tokens, hooks and sessions. Operators run both
// (`cargo xtask admin imports`, `admin reimport`); a refused or repeated run leaves nothing half
// done that a second run would not finish. repo_store/history_reset.rs has the authority's half.

import { audit } from './platform-admin-queries';
import { derivedPrefix, purgePrefix } from './repo-admin';
import { clearCombiners } from './repo-erase';
import { inBatches } from './repo-git-objects';
import { githubRemote } from './repo-git-remote';
import { refreshHead } from './repo-head';
import { askedFor, importRunning, startWorkflow } from './repo-import-start';
import { RepoObjects } from './repo-objects';
import { ApiError, caller, type Json } from './repo-ops';
import { PlatformStore } from './repo-platform-store';
import { ownSpec, parseStore, retiredSpec } from './repo-stores';
import type { Env } from './types';

/** Repositories to an answer: each costs one authority call and a few R2 reads. */
const PAGE = 50;
/** Repositories looked at together. */
const WIDTH = 6;

/** What a repository needs. `check`: a commit too large to stage went whole to the old store,
 * and past the first files only its commit object reached R2, so its older files may be gone
 * though main reads back. */
type Needs = 'nothing' | 'check' | 'reimport';

/** Whether main's commit and top tree are in the store of record, or on their way there. */
async function readsBack(env: Env, repo: string, spec: string, head: Json | null) {
  if (!head) return true;
  const objects = new RepoObjects(env, repo, parseStore(env, spec));
  const wanted = [
    { id: String(head.id), kind: 'commit' },
    { id: String(head.tree), kind: 'tree' },
  ];
  const large = new Map<string, number>();
  const found = await objects.raw(wanted, undefined, large);
  return found.length + large.size === wanted.length;
}

async function auditOne(env: Env, row: { id: string; name: string; workspace: string }) {
  const { id, name, workspace } = row;
  const url = (await askedFor(env, id).catch(() => null))?.url ?? null;
  try {
    const seen = await caller(env, id, { _system: 'import' })({ op: 'repo_store_audit' });
    const spec = String(seen.object_store);
    const retired = retiredSpec(spec);
    const head_readable = await readsBack(env, id, spec, seen.head ?? null).catch(() => false);
    const imported = retired && seen.imported_commits > 0;
    const needs: Needs =
      imported || !head_readable
        ? 'reimport'
        : retired && seen.store_commits > 0
          ? 'check'
          : 'nothing';
    return {
      id,
      name,
      workspace,
      needs,
      url,
      head_readable,
      retired_store: retired,
      commits: seen.commits,
      imported_commits: seen.imported_commits,
      store_commits: seen.store_commits,
    };
  } catch (e: any) {
    return { id, name, workspace, needs: 'check' as Needs, url, error: String(e?.code ?? 'ERROR') };
  }
}

/** `GET /admin/imports?after=<id>`: one page of every repository, in id order, with what each
 * needs. `next`: where the next page starts. */
export async function importAudit(env: Env, after?: string | null) {
  const { results } = await env.INDEX.prepare(
    'SELECT id,name,workspace FROM platform_repos WHERE id>? ORDER BY id LIMIT ?',
  )
    .bind(after ?? '', PAGE)
    .all<{ id: string; name: string; workspace: string }>();
  const repositories = await inBatches(results, WIDTH, (row) => auditOne(env, row));
  return { repositories, next: results.length === PAGE ? results[PAGE - 1].id : null };
}

/** The history a clone replaces, in R2: bundles and raw objects, their cached copies and what
 * was derived from them. Check logs, transcripts and LFS objects stay with what they belong to. */
async function clearHistory(env: Env, repo: string) {
  for (const part of ['bundles', 'git', 'objects'])
    await purgePrefix(env, `platform/v1/${repo}/${part}/`);
  await purgePrefix(env, derivedPrefix(repo));
}

/** `POST /admin/repos/<id>/reimport {url?, branch?, confirm?}`: says what it would do, and with
 * `confirm` does it. The address defaults to the one the repository was imported from. Commit
 * shards stay: emptying one seals it for good, and what they hold nothing refers to any more. */
export async function reimportRepository(env: Env, actor: string, repo: string, body: Json) {
  const call = caller(env, repo, { _system: 'import' });
  const seen = await call({ op: 'repo_store_audit' });
  const spec = String(seen.object_store);
  if (ownSpec(spec) !== spec)
    throw new ApiError('CONFLICT', 'A fork reads its parent: re-import the parent');
  const asked = await askedFor(env, repo);
  const url = githubRemote(String(body.url ?? asked?.url ?? ''));
  if (!url) throw new ApiError('INVALID_INPUT', 'url must be a public GitHub repository');
  const branch = typeof body.branch === 'string' && body.branch ? body.branch : asked?.branch;
  const plan = { id: repo, name: seen.name, url, branch: branch ?? null, commits: seen.commits };
  if (body.confirm !== true) return { dry_run: true, ...plan };
  if (await importRunning(env, repo, asked))
    throw new ApiError('CONFLICT', 'An import of this repository is still running');

  const store = new PlatformStore(env, repo).spec;
  const refs = new Set<string>();
  for (;;) {
    const step = await call({ op: 'repo_import_reset', object_store: store });
    for (const ref of step.refs as string[]) refs.add(ref);
    if (step.done) break;
  }
  await clearHistory(env, repo);
  await clearCombiners(env, repo, [...refs]);
  await refreshHead(env, repo, true);
  const asked_at = Date.now();
  const params = { repo, url, branch, asked_at };
  const workflow = await startWorkflow(env, params, `import-${repo}-${asked_at}`);
  await audit(env, actor, 'repo.reimport', repo, { url, commits: seen.commits });
  return { ...plan, import: workflow };
}
