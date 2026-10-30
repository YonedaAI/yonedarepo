// A search of all the account's repositories. There is no index across repositories, so the
// browser asks each repository's own search API: at most REPO_CAP of them, the most recently
// active first, CONCURRENCY at a time, each answer shown as it arrives.
import type { ActivitySession } from '../shell/homeModel';
import type { PlatformRepo } from '../shell/repoRows';
import { foundNothing, type SearchAnswer, searchPath } from '../source-platform/searchModel';
import { SourceApiError, sourceApi } from '../source-platform/sourceApi';

/** The search API's shortest query. */
export const MIN_QUERY = 2;
export const REPO_CAP = 25;
export const CONCURRENCY = 4;

export type SearchPlan = { repos: string[]; capped: boolean };

/** What one repository answered. `unreadable`: no `main` to search yet, or not this viewer's. */
export type Outcome =
  | { repo: string; kind: 'found'; answer: SearchAnswer }
  | { repo: string; kind: 'none' | 'unreadable' }
  | { repo: string; kind: 'failed'; error: string };

/**
 * The repositories to ask. The browser has no last-push time per repository: the account's
 * newest sessions (`GET /activity`) lead, by their newest session, then the newest created.
 */
export function searchPlan(
  repos: PlatformRepo[],
  sessions: Pick<ActivitySession, 'repo' | 'at'>[],
): SearchPlan {
  const active = new Map<string, number>();
  for (const { repo, at } of sessions) active.set(repo, Math.max(at, active.get(repo) ?? 0));
  const order = [...repos].sort(
    (a, b) =>
      (active.get(b.id) ?? 0) - (active.get(a.id) ?? 0) ||
      (b.created_at ?? 0) - (a.created_at ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return { repos: order.slice(0, REPO_CAP).map((r) => r.id), capped: order.length > REPO_CAP };
}

export const capNote = ({ capped }: Pick<SearchPlan, 'capped'>) =>
  capped
    ? `Searched your ${REPO_CAP} most recent repositories. Pick one to search it fully.`
    : undefined;

/** Runs `run` over `items` in order, `limit` at a time, starting none once `signal` aborts. */
export async function fanOut<T>(
  items: T[],
  run: (item: T) => Promise<void>,
  signal: AbortSignal,
  limit = CONCURRENCY,
) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await run(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** One repository's answer, never a rejection; null for a search cancelled meanwhile. */
export async function askRepository(
  repo: string,
  query: string,
  signal: AbortSignal,
  ask: (path: string, init: { signal: AbortSignal }) => Promise<SearchAnswer> = sourceApi,
): Promise<Outcome | null> {
  try {
    const answer = await ask(searchPath(repo, query), { signal });
    if (signal.aborted) return null;
    return foundNothing(answer) ? { repo, kind: 'none' } : { repo, kind: 'found', answer };
  } catch (e) {
    if (signal.aborted) return null;
    if (e instanceof SourceApiError && e.status === 404) return { repo, kind: 'unreadable' };
    return { repo, kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

export const matched = (outcomes: Outcome[]) =>
  outcomes.filter((o): o is Extract<Outcome, { kind: 'found' }> => o.kind === 'found');

/** Whether a key press landed in a field: `/` is then the character. */
export const isTyping = (
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined,
) =>
  Boolean(target?.isContentEditable) ||
  ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '');
