// What last changed each entry of a directory, as `/log?dir=` answers it, and when a commit was
// written: the author's own time, or for a commit from before that was kept, when it landed here.

export type Activity = {
  commit: string;
  message: string;
  principal: string;
  author_name?: string | null;
  authored_at?: number | null;
  recorded_at: number;
};

/** When `a` was written, as far as is known. */
export const writtenAt = (a: Activity) => a.authored_at ?? a.recorded_at;

/** Directory names first, then files, each alphabetically. */
export function sortEntries<E extends { name: string; type: string }>(entries: E[]): E[] {
  return [...entries].sort(
    (a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
  );
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
