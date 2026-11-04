// Reading files and directories: at a commit, at a branch and version, or (the default for
// main) at main's published head, which serves landed changesets before their Git commit
// is projected. Every read is checked against the caller's directory grant first, and
// resolved without the authority where published or immutable data answers (repo-snapshots).

import type { RepoSnapshot } from '../../shared/contracts/repo-status';
import { decide, outside, requirePath } from './repo-grants';
import type { RepoObjects } from './repo-objects';
import { ApiError, type Json, type RepoContext, walk } from './repo-ops';
import { warmReadTrees } from './repo-read-trees';
import { authorizeRead, headAccess, readTarget } from './repo-snapshots';
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

export async function listTree(ctx: RepoContext, args: Json, admitted?: RepoSnapshot) {
  const path = String(args.path ?? '').replace(/\/$/, '');
  // Main's latest tree is the published head's (read at least at `min_version`).
  const head = admitted ? null : await authorizeRead(ctx, Number(args.min_version ?? 0));
  const view = await decide(ctx, [path], [path]);
  if (!view.paths[0] && !view.dirs[0]) throw outside();
  const where = admitted ?? (await readTarget(ctx, head, args.commit ?? args.ref, args.at));
  const objects = await ctx.objects();
  await warmReadTrees(objects, where.tree, path, where.commit, true);
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

/** Overview's already-authorized root listing selected this immutable commit and entry.
 * Recheck the file grant and withholding; no second commit/head lookup is necessary. */
export async function readFileFromTree(ctx: RepoContext, tree: Json, path: string) {
  await requirePath(ctx, path);
  const entry = (tree.entries as TreeEntry[]).find((e) => e.name === path);
  if (!entry || !['blob', 'exec'].includes(entry.type))
    throw new ApiError('NOT_FOUND', `${path} is not a file`);
  const bytes = await (await ctx.objects()).blob(entry.id);
  return {
    commit: tree.commit,
    path,
    id: entry.id,
    executable: entry.type === 'exec',
    size: bytes.length,
    ...text(bytes),
  };
}

/** What last changed each entry of a directory, one read for a page of the Code tab. Only what
 * the caller may list is asked about. */
export async function treeActivity(ctx: RepoContext, args: Json) {
  const path = String(args.dir ?? '');
  const { entries } = await listTree(ctx, { ...args, path });
  const at = args.at === undefined || args.at === '' ? {} : { at: Number(args.at) };
  const names = (entries as TreeEntry[]).map((e) => e.name);
  return ctx.call({ op: 'repo_dir_activity', ref: args.ref ?? 'main', path, names, ...at });
}

/** A path's entry at main's published head: from the latest changeset that wrote it
 * (walked in its landed commit's tree), else from the projected head. */
async function publishedEntry(objects: RepoObjects, head: Json, path: string) {
  const changed = [...(head.overlay as Json[])]
    .reverse()
    .find((c) => c.paths.some((p: Json) => p.path === path));
  if (!changed) {
    await warmReadTrees(objects, head.head.tree, path, head.head.id);
    return walk(objects, head.head.tree, path);
  }
  const touch = changed.paths.find((p: Json) => p.path === path);
  if (!touch.blob) throw new ApiError('NOT_FOUND', `${path} does not exist`);
  // The log recorded the mode: the blob is read by id, no tree walk.
  if (touch.mode)
    return { name: path.split('/').pop() ?? path, type: touch.mode, id: touch.blob } as TreeEntry;
  await warmReadTrees(objects, changed.tree, path);
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
  // then decides, on the read below). Other reads take only their access from it.
  const fromHead = await headAccess(ctx, main ? Number(args.min_version ?? 0) : 0);
  if (fromHead && main) ctx.publish(fromHead.head, fromHead.access);
  else if (fromHead) ctx.authorize(fromHead.head, fromHead.access);
  await requirePath(ctx, path);
  if (fromHead && main) {
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
  const where = await readTarget(ctx, fromHead?.head ?? null, args.commit ?? args.ref, args.at);
  const objects = await ctx.objects();
  await warmReadTrees(objects, where.tree, path, where.commit);
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
