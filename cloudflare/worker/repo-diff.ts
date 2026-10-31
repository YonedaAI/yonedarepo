// A commit's changes against a base, as the caller may see them (paths filtered by its grant,
// a quarantined side listed but never read), with patches on request.
import { compute } from './repo-compute';
import { decide, keepAllowed } from './repo-grants';
import { type RepoObjects, toBase64 } from './repo-objects';
import { type Json, type RepoContext, target, withTrees } from './repo-ops';

export const PATCH_FILES = 200;
export const PATCH_BYTES = 16 * 1024 * 1024;

/** One changed file's patch fields, spending `budget.bytes` on the blobs it reads. */
export async function patchOf(objects: RepoObjects, change: Json, budget: { bytes: number }) {
  const files = [change.old, change.new].filter((s) => s && ['blob', 'exec'].includes(s.type));
  if (files.length === 0) return {};
  // A quarantined side is not read: the change is listed, its patch marked withheld.
  if ((await objects.withheldAmong(files.map((f) => f.id))).size)
    return { patch_omitted: 'quarantined' };
  const input: Json = { op: 'file_patch' };
  for (const [side, value] of [
    ['old', change.old],
    ['new', change.new],
  ] as const) {
    if (!value || !['blob', 'exec'].includes(value.type)) continue;
    const bytes = await objects.blob(value.id);
    budget.bytes -= bytes.length;
    input[`${side}_id`] = value.id;
    input[`${side}_b64`] = toBase64(bytes);
  }
  if (budget.bytes < 0) return { patch_omitted: 'budget' };
  return compute(input);
}

/** `head` against `base` (default: head's first parent; or their merge base). */
export async function diff(ctx: RepoContext, args: Json) {
  const head = await target(ctx, args.head, args.at);
  let base: Json | null = null;
  if (args.base) {
    base = await target(ctx, args.base, args.at);
    if (args.merge_base) {
      const found = await ctx.call({
        op: 'repo_merge_base',
        left: base.commit,
        right: head.commit,
      });
      base = found.merge_bases[0] ?? null;
    }
  } else if (head.parents[0]) base = await ctx.call({ op: 'repo_commit', commit: head.parents[0] });
  const objects = await ctx.objects();
  let changes: Json[] = (
    await withTrees(objects, { op: 'tree_diff', old: base?.tree ?? null, new: head.tree })
  ).changes;
  changes = (await keepAllowed(ctx, changes)).map((c) => ({ ...c }));
  for (const change of changes)
    if (change.old_path && !(await decide(ctx, [change.old_path])).paths[0]) delete change.old_path;
  const prefix = String(args.path ?? '');
  if (prefix)
    changes = changes.filter(
      (c) => c.path === prefix || c.path.startsWith(`${prefix.replace(/\/$/, '')}/`),
    );
  if (args.patch) {
    const budget = { bytes: PATCH_BYTES };
    for (const change of changes.slice(0, PATCH_FILES)) {
      const patch = await patchOf(objects, change, budget);
      Object.assign(change, patch);
      if (patch.patch_omitted === 'budget') break;
    }
  }
  return {
    base: base ? { commit: base.commit, tree: base.tree } : null,
    head: { commit: head.commit, tree: head.tree },
    changes,
  };
}
