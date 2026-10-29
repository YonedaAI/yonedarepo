// Warm-start seeds (Scion S13): after a branch lands, the platform writes one R2 object with
// every file at the new head. A check run on a nearby commit starts from the seed and
// fetches only the blobs that differ, instead of one tiered read per file. Seeds are a cache:
// a missing, oversized or stale one only means the run reads everything itself.
import type { CheckJob } from './check-container';
import { blobWaves } from './repo-object-waves';
import { type RepoObjects, type TreeEntry, toBase64 } from './repo-objects';
import { ApiError, type Json, withTrees } from './repo-ops';
import { quarantined } from './repo-quarantine-guard';
import type { Env } from './types';

const MAX_FILES = 100_000;
const MAX_BYTES = 192 * 1024 * 1024;
/** Seeds are skipped above this size: a seed's files and its JSON are held at once, in a
 * jobs consumer isolate of 128 MB that may run another job beside it. */
const MAX_SEED_BYTES = 16 * 1024 * 1024;

type SeedFile = CheckJob['files'][number] & { id: string };
type Seed = { commit: string; tree: string; files: SeedFile[] };

/** Seeds hold file content: a purge deletes every one of a repository (repo-quarantine). */
export const seedPrefix = (repo: string) => `platform/v1/${repo}/seeds/`;
const seedKey = (repo: string, ref: string) => `${seedPrefix(repo)}${encodeURIComponent(ref)}.json`;
const tooLarge = () => new ApiError('TOO_LARGE', 'Commit is too large for a platform check');

/** Every file under `tree`: its trees walked, then its blobs read a wave at a time. */
export async function treeFiles(objects: RepoObjects, tree: string, limit = MAX_BYTES) {
  const listed: Omit<SeedFile, 'data_b64'>[] = [];
  const visit = async (id: string, prefix: string) => {
    const entries: TreeEntry[] = await objects.tree(id);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') await visit(entry.id, path);
      else if (entry.type !== 'gitlink') {
        if (listed.length >= MAX_FILES) throw tooLarge();
        listed.push({ path, type: entry.type, id: entry.id });
      }
    }
  };
  await visit(tree, '');
  const data = new Map<string, string>();
  const sizes = new Map<string, number>();
  let unique = 0;
  for await (const wave of blobWaves(
    objects,
    listed.map((f) => f.id),
  ))
    for (const [id, bytes] of wave) {
      unique += bytes.length;
      if (unique > limit) throw tooLarge();
      data.set(id, toBase64(bytes));
      sizes.set(id, bytes.length);
    }
  // Files sharing content are shipped (and counted) once each.
  if (listed.reduce((n, f) => n + (sizes.get(f.id) ?? 0), 0) > limit) throw tooLarge();
  return listed.map((f) => ({ ...f, data_b64: data.get(f.id) as string }));
}

/** Writes the seed for `ref` at `head` (best effort: an oversized tree gets no seed). */
export async function writeSeed(
  env: Env,
  repo: string,
  objects: RepoObjects,
  ref: string,
  head: { commit: string; tree: string },
) {
  // Every landing on the ref queues a derive job; one seed per head is enough.
  const current = await env.OBJECTS.head(seedKey(repo, ref));
  if (current?.customMetadata?.tree === head.tree) return { commit: head.commit, unchanged: true };
  let files: SeedFile[];
  try {
    files = await treeFiles(objects, head.tree, MAX_SEED_BYTES);
  } catch (e: any) {
    if (e?.code === 'TOO_LARGE') return null;
    throw e;
  }
  const seed: Seed = { commit: head.commit, tree: head.tree, files };
  await env.OBJECTS.put(seedKey(repo, ref), JSON.stringify(seed), {
    customMetadata: { commit: head.commit, tree: head.tree },
  });
  return { commit: head.commit, files: files.length };
}

/**
 * SHA-256 (hex) of a checked file set: one `<type> <blob id> <path>\n` line per file,
 * ordered by path (UTF-16 code units), so it can be recomputed from the tree's file listing
 * (gitlinks excluded).
 */
export async function fileSetDigest(files: Omit<SeedFile, 'data_b64'>[]) {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => `${f.type} ${f.id} ${f.path}\n`);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The files of `tree` for a check run: from the seed of `ref` plus the blobs that differ,
 * or read in full without a usable seed. Reports how many blobs it fetched and the digest
 * of the file set it returns.
 */
export async function checkFiles(
  env: Env,
  repo: string,
  objects: RepoObjects,
  tree: string,
  ref = 'main',
): Promise<{
  files: CheckJob['files'];
  seed: { commit: string; fetched: number } | null;
  files_sha256: string;
}> {
  const stored = await env.OBJECTS.get(seedKey(repo, ref));
  if (!stored) {
    const files = await treeFiles(objects, tree);
    return { files: strip(files), seed: null, files_sha256: await fileSetDigest(files) };
  }
  const seed = await stored.json<Seed>();
  const byPath = new Map(seed.files.map((f) => [f.path, f]));
  const { changes } = await withTrees(objects, { op: 'tree_diff', old: seed.tree, new: tree });
  let fetched = 0;
  for (const change of changes as Json[]) {
    if (change.old_path) byPath.delete(change.old_path);
    if (!change.new) {
      byPath.delete(change.path);
      continue;
    }
    if (change.new.type === 'gitlink') continue;
    const data = await objects.blob(change.new.id);
    fetched++;
    byPath.set(change.path, {
      path: change.path,
      type: change.new.type,
      id: change.new.id,
      data_b64: toBase64(data),
    });
  }
  const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  // A seed written before a quarantine may still hold the content: never shipped.
  const [held] = await objects.withheldAmong(files.map((f) => f.id));
  if (held) throw quarantined(held[0], held[1]);
  const bytes = files.reduce((sum, f) => sum + (f.data_b64.length * 3) / 4, 0);
  if (files.length > MAX_FILES || bytes > MAX_BYTES)
    throw new ApiError('TOO_LARGE', 'Commit is too large for a platform check');
  return {
    files: strip(files),
    seed: { commit: seed.commit, fetched },
    files_sha256: await fileSetDigest(files),
  };
}

const strip = (files: SeedFile[]) => files.map(({ id: _id, ...file }) => file);
