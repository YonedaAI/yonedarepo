/** Operator listing transport. Database size is the last sampled SQLite size, not file storage. */
export type RepositorySort = 'name' | 'owner' | 'visibility' | 'created' | 'database';
export type SortDirection = 'asc' | 'desc';
export type RepositoryOrder = { sort: RepositorySort; direction: SortDirection };
export type RepositoryFilters = { owner: string; visibility: '' | 'public' | 'private' };
export type RepositoryListing = {
  id: string;
  name: string;
  owner: string;
  handle: string | null;
  visibility: 'public' | 'private';
  created_at: number;
  db_bytes: number | null;
  level: number | null;
  /** Selected SQL ordering value, used only to merge bounded pages across cells. */
  sort_value: string | number | null;
};
export type RepositoryPage = { items: RepositoryListing[]; next: string | null; partial?: boolean };
