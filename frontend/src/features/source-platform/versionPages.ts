import { legacyVersions } from './legacyVersions';
import { SourceApiError, sourceApi } from './sourceApi';

export type { VersionEntry, VersionPage } from './versionModel';
export { VERSION_PAGE } from './versionModel';

import { VERSION_PAGE, type VersionEntry, type VersionPage, versionsChanged } from './versionModel';

function checked(value: VersionPage & { format?: string }, compact: boolean): VersionPage {
  if (
    value.format !== 'recent-versions-v1' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !(
      (typeof value.history_chain === 'string' && value.history_chain.length > 0) ||
      (value.version === 0 && value.history_chain === null)
    ) ||
    !Array.isArray(value.entries) ||
    value.entries.length > VERSION_PAGE
  )
    throw new Error('Could not read version pages. Refresh to try again.');
  for (const [i, e] of value.entries.entries()) {
    if (
      !Number.isSafeInteger(e.version) ||
      e.version < 1 ||
      e.version > value.version ||
      typeof e.kind !== 'string' ||
      !Number.isSafeInteger(e.committed_at_ms) ||
      (i > 0 && value.entries[i - 1].version !== e.version + 1) ||
      (!compact &&
        (typeof e.actor !== 'string' ||
          typeof e.refname !== 'string' ||
          typeof e.chain !== 'string' ||
          !Array.isArray(e.paths) ||
          e.paths.some((p) => !p || typeof p.path !== 'string' || typeof p.op !== 'string')))
    )
      throw new Error('Could not read version pages. Refresh to try again.');
  }
  const last = value.entries.at(-1)?.version ?? 1;
  if (value.next_before !== (last > 1 ? last : null)) throw versionsChanged();
  return value;
}

export async function readVersionPage(
  repo: string,
  recent: boolean,
  known: number,
  compact: boolean,
  signal: AbortSignal,
  previous?: VersionPage,
): Promise<VersionPage> {
  if (!recent || previous?.legacy) return legacyVersions(repo, known, compact, signal, previous);
  const query = new URLSearchParams({
    limit: String(VERSION_PAGE),
    ...(compact && { compact: 'true' }),
  });
  if (previous) {
    query.set('through', String(previous.version));
    query.set('history_chain', previous.history_chain ?? '');
    query.set('before', String(previous.next_before));
  }
  let value: VersionPage;
  try {
    value = checked(await sourceApi(`/repos/${repo}/versions?${query}`, { signal }), compact);
  } catch (e) {
    // Only an explicit disabled capability permits compatibility fallback. A denial never does.
    if (e instanceof SourceApiError && e.code === 'NOT_SUPPORTED')
      return legacyVersions(repo, known, compact, signal, previous);
    throw e;
  }
  const upper = previous ? Number(previous.next_before) - 1 : value.version;
  if (
    (value.entries[0]?.version ?? 0) !== upper ||
    (previous &&
      (value.version !== previous.version || value.history_chain !== previous.history_chain))
  )
    throw versionsChanged();
  return value;
}

/** Keeps an explicit old selection reachable before its page has been opened. */
export function versionChoices(entries: VersionEntry[], selected?: number) {
  return selected !== undefined && !entries.some((e) => e.version === selected)
    ? [{ version: selected, kind: '', committed_at_ms: 0 }, ...entries]
    : entries;
}
