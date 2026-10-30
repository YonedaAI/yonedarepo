// What last changed each entry of a directory, read from the transaction log (one read for
// the whole directory): every landing on a branch lists the paths it changed.

export type LogEntry = {
  version: number;
  kind: string;
  refname: string;
  new?: string | null;
  paths: { path: string; op: string }[];
  actor: string;
  committed_at_ms: number;
};
export type Activity = { commit: string; at: number; actor: string; version: number };

/** Directory names first, then files, each alphabetically. */
export function sortEntries<E extends { name: string; type: string }>(entries: E[]): E[] {
  return [...entries].sort(
    (a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
  );
}

/**
 * The newest log entry on branch `ref` (at or before version `at`) that changed something
 * under each of `names` in directory `dir`. Names the window does not cover are absent.
 */
export function directoryActivity(
  entries: LogEntry[],
  ref: string,
  dir: string,
  names: string[],
  at?: number,
): Map<string, Activity> {
  const refname = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
  const wanted = new Set(names);
  const found = new Map<string, Activity>();
  const newestFirst = [...entries].sort((a, b) => b.version - a.version);
  for (const entry of newestFirst) {
    if (found.size === wanted.size) break;
    if (entry.refname !== refname || !entry.new || (at !== undefined && entry.version > at))
      continue;
    for (const { path } of entry.paths) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length).split('/')[0];
      if (!wanted.has(name) || found.has(name)) continue;
      found.set(name, {
        commit: entry.new,
        at: entry.committed_at_ms,
        actor: entry.actor,
        version: entry.version,
      });
    }
  }
  return found;
}

const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [365 * 86_400_000, 'year'],
  [30 * 86_400_000, 'month'],
  [7 * 86_400_000, 'week'],
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 days ago", "just now". */
export function ago(ms: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - ms);
  for (const [size, unit] of UNITS)
    if (elapsed >= size) return relative.format(-Math.floor(elapsed / size), unit);
  return 'just now';
}
