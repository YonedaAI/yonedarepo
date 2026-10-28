// Archived log segments (repo_store/maintenance in Rust). Below its compaction floor the
// authority keeps only the fingerprints of the segment objects in R2: a read there answers
// TXLOG_ARCHIVED naming the two objects, and the caller retries with their text in
// `_archive`, which the authority accepts only when it matches the recorded fingerprints.
import type { Env } from './types';

/** An archived object's R2 key (the authority names keys relative to the repository). */
export const archiveKey = (repo: string, key: string) => `platform/v1/${repo}/${key}`;

const named = (message: string, kind: string) =>
  message.match(new RegExp(`_log/${kind}-[0-9-]+\\.json`))?.[0];

/** `_archive` for a TXLOG_ARCHIVED answer, or null when the answer names no objects. A
 * missing object is sent as null and refused by the authority (ARCHIVE_CORRUPT). */
export async function archivedObjects(env: Env, repo: string, message: string) {
  const segment = named(message, 'segment');
  const checkpoints = named(message, 'checkpoint');
  if (!segment || !checkpoints) return null;
  const text = async (key: string) =>
    (await (await env.OBJECTS.get(archiveKey(repo, key)))?.text()) ?? null;
  const [s, c] = await Promise.all([text(segment), text(checkpoints)]);
  return { segment: s, checkpoints: c };
}
