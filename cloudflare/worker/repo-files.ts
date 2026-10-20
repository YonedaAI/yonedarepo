// Reading files and directories: at a commit, at a branch and version, or (the default for
// main) at main's published head, which serves landed changesets before their Git commit
// is projected. Every read is checked against the caller's directory grant first.
import { decide, outside, requirePath } from './repo-grants';
import { readFromHead } from './repo-head';
import type { RepoObjects } from './repo-objects';
import { ApiError, type Json, type RepoContext, target, walk } from './repo-ops';
import { type TreeEntry, toBase64 } from './repo-stores';

function text(bytes: Uint8Array) {
  try {
    return {
      encoding: 'utf-8',
      content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { encoding: 'base64', content: toBase64(bytes) };
  }
}

export async function listTree(ctx: RepoContext, args: Json) {
  const path = String(args.path ?? '').replace(/\/$/, '');
  const view = await decide(ctx, [path], [path]);
  if (!view.paths[0] && !view.dirs[0]) throw outside();
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  const entry = await walk(objects, where.tree, path);
  if (entry.type !== 'tree') throw new ApiError('NOT_FOUND', `${path} is not a directory`);
  let entries = await objects.tree(entry.id);
  if (view.restricted) {
    // Directories on the way to a grant list only the entries that lead into it.
    const full = entries.map((e) => (path ? `${path}/${e.name}` : e.name));
    const seen = await decide(ctx, full, full);
    entries = entries.filter((e, i) => seen.paths[i] || (e.type === 'tree' && seen.dirs[i]));
  }
  return { commit: where.commit, path, entries };
}

/** A path's entry at main's published head: from the latest changeset that wrote it
 * (walked in its landed commit's tree), else from the projected head. */
async function publishedEntry(objects: RepoObjects, head: Json, path: string) {
  const changed = [...(head.overlay as Json[])]
    .reverse()
    .find((c) => c.paths.some((p: Json) => p.path === path));
  if (!changed) return walk(objects, head.head.tree, path);
  const touch = changed.paths.find((p: Json) => p.path === path);
  if (!touch.blob) throw new ApiError('NOT_FOUND', `${path} does not exist`);
  // The log recorded the mode: the blob is read by id, no tree walk.
  if (touch.mode)
    return { name: path.split('/').pop() ?? path, type: touch.mode, id: touch.blob } as TreeEntry;
  return walk(objects, changed.tree, path);
}

/** A file at a commit, at a branch and version, or (by default) at main's published head,
 * which a reader that landed something reads at least at its landing's `min_version`. */
export async function readFile(ctx: RepoContext, args: Json) {
  const path = String(args.path ?? '');
  const main =
    !args.commit &&
    (args.at === undefined || args.at === null || args.at === '') &&
    [undefined, null, '', 'main', 'refs/heads/main'].includes(args.ref);
  // Main's published head, unless its access snapshot refused the caller (the authority
  // then decides, on the read below).
  const fromHead = main ? await readFromHead(ctx, Number(args.min_version ?? 0)) : null;
  if (fromHead) ctx.publish(fromHead.head, fromHead.access);
  await requirePath(ctx, path);
  if (fromHead) {
    const objects = await ctx.objects();
    const entry = await publishedEntry(objects, ctx.published as Json, path);
    if (!['blob', 'exec'].includes(entry.type))
      throw new ApiError('NOT_FOUND', `${path} is not a file`);
    const bytes = await objects.blob(entry.id);
    const head = ctx.published as Json;
    return {
      version: head.version,
      // The Git commit at that version, once it is projected (null while changesets wait).
      commit: head.overlay.length ? null : head.head.id,
      path,
      id: entry.id,
      executable: entry.type === 'exec',
      size: bytes.length,
      ...text(bytes),
    };
  }
  const where = await target(ctx, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  const entry = await walk(objects, where.tree, path);
  if (!['blob', 'exec'].includes(entry.type))
    throw new ApiError('NOT_FOUND', `${path} is not a file`);
  const bytes = await objects.blob(entry.id);
  return {
    commit: where.commit,
    path,
    id: entry.id,
    executable: entry.type === 'exec',
    size: bytes.length,
    ...text(bytes),
  };
}
