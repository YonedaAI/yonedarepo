const REPOSITORY_LINK_PARAMS = ['repo', 'run', 'guided', 'session'];

export interface RepositorySelectionInput {
  /** Repository named by the page's original `?repo=` link, if any. */
  requested: string;
  current: string;
  available: { id: string }[];
  /** Repositories this session deleted; a link to one of them is no longer an error. */
  deleted: ReadonlySet<string>;
  /** The link applies to the first discovery only; later refreshes and deletes ignore it. */
  linkFollowed?: boolean;
}

export function selectRepository({
  requested,
  current,
  available,
  deleted,
  linkFollowed = false,
}: RepositorySelectionInput): { id: string; missing: boolean } {
  const exists = (id: string) => available.some((repo) => repo.id === id);
  const id = exists(current) ? current : (available[0]?.id ?? '');
  const missing = !linkFollowed && !!requested && !deleted.has(requested) && !exists(requested);
  return { id, missing };
}

export function withoutRepositoryLink(href: string): string {
  const url = new URL(href);
  for (const name of REPOSITORY_LINK_PARAMS) url.searchParams.delete(name);
  return url.toString();
}
