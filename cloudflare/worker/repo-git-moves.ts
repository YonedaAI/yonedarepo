// The ref updates of a `git push` over HTTPS (receive-pack), once its objects are stored:
// which refs are refused outright, and how each one that goes ahead moves. Working
// branches move by compare-and-swap (one batch for `--atomic`), protected branches by
// landing, with the server's merge when they moved meanwhile, and new lightweight tags by
// creation (tags never move or disappear).

import { landMode } from './repo-changesets';
import { landWithMerge } from './repo-landing';
import { ApiError, type Json, type RepoContext } from './repo-ops';

export type Command = {
  ref: string;
  old: string | null;
  new: string | null;
  protected: boolean;
  /** The new value is an annotated tag object (`git tag -a`), which is not stored. */
  annotated: boolean;
};
export type Outcome = Map<string, string | null>;

export const reason = (e: any) =>
  `${e instanceof ApiError ? e.code : (e?.code ?? 'ERROR')}: ${String(e?.message ?? e)}`.slice(
    0,
    300,
  );
const short = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** Why a ref is refused before anything is stored (`null`: it goes ahead). */
export function refusal(command: Command, atomic: boolean): string | null {
  if (command.ref.startsWith('refs/tags/')) {
    if (!command.new) return 'tags are immutable and cannot be deleted';
    if (command.annotated)
      return 'annotated tags are not supported: push a lightweight tag (git tag <name>)';
    if (command.old) return 'tags are immutable: this tag already exists';
    return null;
  }
  if (!command.ref.startsWith('refs/heads/'))
    return 'only branches (refs/heads/*) and tags (refs/tags/*) can be pushed';
  if (command.protected && !command.new)
    return `${short(command.ref)} is protected and cannot be deleted`;
  if (command.protected && atomic)
    return `an atomic push cannot include ${short(command.ref)}: it moves only by landing`;
  return null;
}

/** `--atomic`: every working branch move and tag creation in one transaction, or none. */
export async function moveAll(ctx: RepoContext, going: Command[], outcomes: Outcome) {
  if (going.length === 0) return;
  const updates = going.map((c) => ({ ref: c.ref, commit: c.new, expected: c.old }));
  try {
    const moved = await ctx.call({ op: 'repo_branch_batch', updates });
    const stale: string[] = moved.stale ?? [];
    for (const c of going)
      if (stale.length > 0)
        outcomes.set(c.ref, stale.includes(c.ref) ? 'fetch first' : 'atomic push refused');
  } catch (e) {
    for (const c of going) outcomes.set(c.ref, reason(e));
  }
}

/** One ref: a working branch by compare-and-swap (a tag by creation, the same call), a
 * protected one by landing. */
export async function moveOne(
  ctx: RepoContext,
  c: Command,
  fresh: Set<string>,
  messages: string[],
): Promise<string | null> {
  try {
    if (c.protected && c.new) return await land(ctx, c, c.new, fresh, messages);
    const moved = await ctx.call({
      op: 'repo_branch_batch',
      updates: [{ ref: c.ref, commit: c.new, expected: c.old }],
    });
    return moved.stale ? 'fetch first' : null;
  } catch (e) {
    return reason(e);
  }
}

/** Lands `sha` on a protected branch, as `POST /land` does: a fast-forward keeps the
 * pushed commit; otherwise the server merges, or refuses an overlap as a conflict. A
 * commit the branch already holds (an older head pushed again) lands nothing. */
async function land(
  ctx: RepoContext,
  c: Command,
  sha: string,
  fresh: Set<string>,
  messages: string[],
) {
  const branch = short(c.ref);
  if (!fresh.has(sha)) {
    const head = await ctx.call({ op: 'repo_snapshot', ref: c.ref }).catch((e) => {
      if (e?.code === 'NOT_FOUND') return null;
      throw e;
    });
    if (head && head.commit !== sha) {
      const { merge_bases } = await ctx.call({
        op: 'repo_merge_base',
        left: sha,
        right: head.commit,
      });
      if (merge_bases.some((b: Json) => b.commit === sha)) return null;
    }
  }
  try {
    const landed: Json = await landWithMerge(ctx, c.ref, sha, false, landMode(ctx.env));
    // A merge commit, or a changeset whose Git commit the server builds: not `sha` itself.
    const head = landed.merge ?? ('git_commit' in landed ? landed.git_commit : sha);
    if (head !== sha) messages.push(`${branch}: landed with server merge, run git pull`);
    return null;
  } catch (e: any) {
    if (e?.code !== 'CONFLICT') return reason(e);
    const paths = conflictPaths(e);
    for (const path of paths) messages.push(`conflict in ${path}`);
    messages.push('next: git pull, resolve the conflicts, commit, git push');
    return `conflict${paths.length ? ` in ${paths.join(', ')}` : ''}: run git pull`.slice(0, 300);
  }
}

/** The conflicting paths a CONFLICT names, in details or (as the log check words it) its
 * message. */
function conflictPaths(e: any): string[] {
  const details = e?.details ?? {};
  const named = [...(details.conflicts ?? []), ...(details.paths ?? [])]
    .map((p: any) => (typeof p === 'string' ? p : p?.path))
    .filter((p: unknown): p is string => typeof p === 'string');
  if (named.length > 0) return [...new Set(named)].sort();
  const listed = /on (.+), which this commit read/.exec(String(e?.message ?? ''));
  return listed ? listed[1].split(', ') : [];
}
