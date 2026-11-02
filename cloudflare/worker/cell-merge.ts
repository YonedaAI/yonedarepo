// What several cells' answers to one account-wide read come to.
import type { Json } from './repo-ops';

/** Listed repositories of several cells, newest first, each once. */
export function mergeListed<T extends { repos: { id: string; created_at?: number }[] }>(
  parts: T[],
  limit = 200,
): T {
  const seen = new Map(parts.flatMap((p) => p.repos).map((r) => [r.id, r]));
  const repos = [...seen.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return { ...parts[0], repos: repos.slice(0, limit) };
}

/** The newest of `next`s, so that no cell's repositories are skipped: another cell's may come
 * round again on the next page. */
const newestNext = (cursors: (string | null | undefined)[]) =>
  cursors
    .filter((c): c is string => Boolean(c))
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0] ?? null;

/** One search page's answers from several cells. */
export function mergeSearch(parts: Json[]): Json {
  const flat = (key: string) => parts.flatMap((p) => p[key] as Json[]);
  const sum = (key: string) => parts.reduce((total, p) => total + Number(p[key] ?? 0), 0);
  return {
    ...parts[0],
    results: flat('results'),
    failed: flat('failed'),
    searched: sum('searched'),
    scanned: sum('scanned'),
    next: newestNext(parts.map((p) => p.next)),
  };
}
