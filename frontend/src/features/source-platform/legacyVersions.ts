// Old servers already implement ascending after windows. Never send a desc flag they may
// ignore, or call an earliest page "newest". Anchor older pages to the first page's chain.
import { sourceApi } from './sourceApi';
import { VERSION_PAGE, type VersionEntry, type VersionPage, versionsChanged } from './versionModel';

type Ascending = { version: number; entries: VersionEntry[] };
const read = (repo: string, after: number, limit: number, signal: AbortSignal) =>
  sourceApi<Ascending>(`/repos/${repo}/txlog?after=${after}&limit=${limit}`, { signal });

/** A fresh anchor fences all windows, including the first fragmented page. */
function chainAt(page: Ascending, through: number): string | null {
  if (!Number.isSafeInteger(page.version) || page.version < through || !Array.isArray(page.entries))
    throw versionsChanged();
  if (through === 0) {
    if (page.version !== 0 || page.entries.length) throw versionsChanged();
    return null;
  }
  const entry = page.entries[0];
  if (
    page.entries.length !== 1 ||
    entry?.version !== through ||
    typeof entry.chain !== 'string' ||
    !entry.chain
  )
    throw versionsChanged();
  return entry.chain;
}

export async function legacyVersions(
  repo: string,
  known: number,
  compact: boolean,
  signal: AbortSignal,
  previous?: VersionPage,
): Promise<VersionPage> {
  let through = previous?.version ?? known;
  let anchor = await read(repo, Math.max(0, through - 1), 1, signal);
  if (!Number.isSafeInteger(anchor.version) || anchor.version < through) throw versionsChanged();
  if (!previous && anchor.version > through) {
    through = anchor.version;
    anchor = await read(repo, through - 1, 1, signal);
  }
  const chain = chainAt(anchor, through);
  if (previous && chain !== previous.history_chain) throw versionsChanged();
  const upper = previous ? Number(previous.next_before) - 1 : through;
  const lower = Math.max(0, upper - VERSION_PAGE);
  let after = lower;
  const entries: VersionEntry[] = [];
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
  // A reset can reuse every version number while any window is in flight. Do not
  // label those rows with the old snapshot just because its opening check passed.
  const closing = await read(repo, Math.max(0, through - 1), 1, signal);
  if (chainAt(closing, through) !== chain) throw versionsChanged();
  if (!previous && entries.length && entries.at(-1)?.chain !== chain) throw versionsChanged();
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
