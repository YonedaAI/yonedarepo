// A repository's database size. Durable Object SQLite refuses writes at about 10.7 GB, so the
// derive job reads the size now and then and the activity row keeps it for the admin pages;
// a repository crossing an alert level is logged once (repo-activity.ts).
import { caller } from './repo-ops';
import type { Env } from './types';

/** The least time between two reads of one repository's size in this isolate. */
const SAMPLE_MS = 10 * 60 * 1000;
/** Repositories this isolate remembers sampling; past this it starts over. */
const SAMPLES_KEPT = 4096;
/** Database sizes an operator hears about, in bytes. */
export const STORAGE_LEVELS = [5e9, 8e9, 9e9];

const sampled = new Map<string, number>();

/** `repo`'s database size if a sample is due; undefined otherwise or when the read fails (the
 * sample only feeds the admin pages). */
export async function sampleStorage(env: Env, repo: string, now = Date.now()) {
  const last = sampled.get(repo);
  if (last !== undefined && now - last < SAMPLE_MS) return undefined;
  if (sampled.size >= SAMPLES_KEPT) sampled.clear();
  sampled.set(repo, now);
  return caller(env, repo, { _system: 'derive' })({ op: 'repo_storage' }).then(
    (storage) => Number(storage.db_bytes),
    (e) => {
      console.warn(`storage sample failed: ${e?.message ?? e}`);
      return undefined;
    },
  );
}

/** Logs each alert level the size crossed going up from `before`. */
export function logCrossings(repo: string, before: number, bytes: number) {
  for (const level of STORAGE_LEVELS)
    if (before < level && bytes >= level)
      console.log(JSON.stringify({ event: 'repo.storage', repo, level, db_bytes: bytes }));
}

/** The highest alert level `bytes` has reached, or null. */
export const storageLevel = (bytes: number) => STORAGE_LEVELS.findLast((l) => bytes >= l) ?? null;
