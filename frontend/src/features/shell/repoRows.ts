// The sidebar's repositories: every platform repository the account can use, by name. A
// public one carries a badge; other accounts' public repositories are on Explore, not here.
import type { Visibility } from '../source-platform/repoAccess';

/** `GET /api/v1/repos`: `role` is `owner` for the account's own repositories. */
export type PlatformRepo = {
  id: string;
  name: string;
  created_at?: number;
  owner?: string;
  role?: string;
  visibility?: Visibility;
};

export type RepoRow = {
  repo: string;
  name: string;
  /** Another account's repository this account is a member of: `owner · role`. */
  shared?: string;
  /** Anyone may read it. */
  public?: boolean;
};

/** A row's spoken name: "acme, ada · write, public", never its small labels run together. */
export const rowLabel = (row: RepoRow) => {
  const labels = [row.shared, row.public ? 'public' : undefined].filter(Boolean);
  return labels.length ? `${row.name}, ${labels.join(', ')}` : undefined;
};

export function repoRows(platform: PlatformRepo[]): RepoRow[] {
  return platform
    .map((repo) => ({
      repo: repo.id,
      name: repo.name || repo.id,
      shared: repo.role && repo.role !== 'owner' ? `${repo.owner} · ${repo.role}` : undefined,
      ...(repo.visibility === 'public' ? { public: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
}
