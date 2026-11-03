// Old servers already implement ascending after windows. Never send a desc flag they may
// ignore, or call an earliest page "newest". Anchor older pages to the first page's chain.
import { sourceApi } from './sourceApi';
import { VERSION_PAGE, type VersionEntry, type VersionPage, versionsChanged } from './versionModel';

type Ascending = { version: number; entries: VersionEntry[] };
const read = (repo: string, after: number, limit: number, signal: AbortSignal) =>
  sourceApi<Ascending>(`/repos/${repo}/txlog?after=${after}&limit=${limit}`, { signal });

export async function legacyVersions(
  repo: string,
  known: number,
  compact: boolean,
  signal: AbortSignal,
  previous?: VersionPage,
): Promise<VersionPage> {
  let through = previous?.version ?? known;
  if (previous && through > 0) {
    const anchor = await read(repo, through - 1, 1, signal);
    if (
      anchor.version < through ||
      anchor.entries[0]?.version !== through ||
      anchor.entries[0]?.chain !== previous.history_chain
    )
      throw versionsChanged();
  }
  let upper = previous ? Number(previous.next_before) - 1 : through;
  let lower = Math.max(0, upper - VERSION_PAGE);
  let after = lower;
  const entries: VersionEntry[] = [];
  let rebased = false;
  // An archived ascending page can end at a segment boundary. Progress is strictly
  // bounded by these 50 versions, including one-version segments on an old server.
  while (after < upper) {
    const page = await read(repo, after, upper - after, signal);
    if (
      !Number.isSafeInteger(page.version) ||
      page.version < through ||
      !Array.isArray(page.entries)
    )
      throw versionsChanged();
    if (!previous && !rebased && page.version > through) {
      through = page.version;
      upper = through;
      lower = Math.max(0, upper - VERSION_PAGE);
      after = lower;
      rebased = true;
      continue;
    }
    if (!page.entries.length || page.entries.length > upper - after) throw versionsChanged();
    for (const entry of page.entries) {
      if (
        entry.version !== after + 1 ||
        typeof entry.chain !== 'string' ||
        typeof entry.kind !== 'string'
      )
        throw versionsChanged();
      entries.push(entry);
      after = entry.version;
    }
  }
  const chain = previous?.history_chain ?? entries.at(-1)?.chain ?? null;
  return {
    version: through,
    history_chain: chain,
    legacy: true,
    next_before: lower > 0 ? lower + 1 : null,
    entries: entries
      .reverse()
      .map((e) =>
        compact ? { version: e.version, kind: e.kind, committed_at_ms: e.committed_at_ms } : e,
      ),
  };
}
