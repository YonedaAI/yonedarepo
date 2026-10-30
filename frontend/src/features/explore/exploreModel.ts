// Explore: every public repository, newest first (`GET /explore`, no account needed), read a
// page at a time. The next page starts strictly before the oldest repository shown.
export const EXPLORE_PAGE = 50;

export type ExploreRepo = {
  id: string;
  name: string;
  owner: string;
  /** The owner's handle; null while an email-named owner has none. */
  owner_handle?: string | null;
  created_at: number;
  visibility: 'public';
};

export const explorePath = (before?: number) =>
  before === undefined
    ? `/explore?limit=${EXPLORE_PAGE}`
    : `/explore?limit=${EXPLORE_PAGE}&before=${before}`;

/**
 * The pages read so far as one list: duplicates dropped (a repository made private and public
 * again between reads may move), and `next` set while the last page was full.
 */
export function exploreList(pages: ExploreRepo[][]): { repos: ExploreRepo[]; next?: number } {
  const seen = new Set<string>();
  const repos: ExploreRepo[] = [];
  for (const page of pages)
    for (const repo of page)
      if (!seen.has(repo.id)) {
        seen.add(repo.id);
        repos.push(repo);
      }
  const last = pages.at(-1);
  const oldest = last?.at(-1);
  return last && last.length >= EXPLORE_PAGE && oldest
    ? { repos, next: oldest.created_at }
    : { repos };
}

/** "created 3 Oct 2026": the day, which is all a list needs. */
export const createdOn = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
