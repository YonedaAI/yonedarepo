// Archived log segments (repo_store/maintenance in Rust). Below its compaction floor the
// authority keeps only the fingerprints of the segment objects in R2. A command needing
// them answers TXLOG_ARCHIVED naming the objects (a read's segment and checkpoints, or
// the segments a landing checks against); the caller retries with their text in
// `_archive`, which the authority accepts only when it matches the recorded fingerprints.
import type { Env } from './types';

/** An archived object's R2 key (the authority names keys relative to the repository). */
export const archiveKey = (repo: string, key: string) => `platform/v1/${repo}/${key}`;

/** At most this many objects per retry (16 segments and their checkpoints, with room). */
const MAX_OBJECTS = 40;

/** `_archive` for a TXLOG_ARCHIVED answer: every object it names, by key, as text (null
 * when missing: the authority refuses it), or null when the answer names none. */
export async function archivedObjects(env: Env, repo: string, message: string) {
  const keys = [...new Set(message.match(/_log\/(?:segment|checkpoint)-[0-9-]+\.json/g) ?? [])];
  if (keys.length === 0 || keys.length > MAX_OBJECTS) return null;
  const texts = await Promise.all(
    keys.map(async (key) => (await (await env.OBJECTS.get(archiveKey(repo, key)))?.text()) ?? null),
  );
  return Object.fromEntries(keys.map((key, i) => [key, texts[i]]));
}
