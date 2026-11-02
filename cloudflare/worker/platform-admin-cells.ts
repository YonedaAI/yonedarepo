// The operators' lists and totals when accounts and repositories live in several D1s: each cell
// answers the same operator route for what it holds, and the pages merge it. With one cell they
// are what they always were.
import { acrossCells } from './cell-route';
import { allCells, thisCell } from './cells';
import { PAGE } from './platform-admin-queries';
import type { Env, Json } from './types';

type Row = { created_at: number };
type Page = Json & { items: Row[]; next: number | null };

/** `local`'s route, across every cell. */
export const everyCell = <T extends Json>(
  env: Env,
  path: string,
  local: () => Promise<T>,
  merge: (parts: T[]) => T,
) =>
  acrossCells(
    env,
    path,
    local,
    merge,
    allCells(env).filter((cell) => cell !== thisCell(env)),
  );

const newest = (parts: { items: Row[] }[]) =>
  parts.flatMap((p) => p.items).sort((a, b) => b.created_at - a.created_at);

/** Pages of several cells, newest first: `next` is where the merged page stopped, whichever
 * cell that row came from, so nothing past it is lost. */
export function mergePages<T extends Json>(parts: T[]): T {
  const pages = parts as unknown as Page[];
  const rows = newest(pages);
  const items = rows.slice(0, PAGE);
  const more = rows.length > PAGE || pages.some((p) => p.next !== null);
  return { ...parts[0], items, next: more ? (items.at(-1)?.created_at ?? null) : null };
}

/** The sign-up feed of several cells, and what came since the last look. */
export function mergeSignups<T extends Json>(parts: T[]): T {
  const unread = parts.reduce((total, part) => total + Number(part.unread ?? 0), 0);
  return { ...parts[0], items: newest(parts as unknown as Page[]).slice(0, PAGE), unread };
}

const addFields = (parts: Json[], key: string) => {
  const added: Record<string, number> = {};
  for (const part of parts)
    for (const [name, n] of Object.entries(part[key] as Record<string, number>))
      added[name] = (added[name] ?? 0) + n;
  return added;
};

/** Each cell's totals added up. */
export function mergeOverview<T extends Json>(parts: T[]): T {
  const days = new Map<string, number>();
  for (const part of parts)
    for (const { day, count } of part.signups_per_day as { day: string; count: number }[])
      days.set(day, (days.get(day) ?? 0) + count);
  return {
    ...parts[0],
    accounts: addFields(parts, 'accounts'),
    repos: addFields(parts, 'repos'),
    suspended: parts.reduce((total, part) => total + Number(part.suspended ?? 0), 0),
    signups_per_day: [...days].map(([day, count]) => ({ day, count })),
  };
}
