// The sidebar's repositories: every platform repository the account can use, by name.

/** `GET /api/v1/repos`: `role` is `owner` for the account's own repositories. */
export type PlatformRepo = {
  id: string;
  name: string;
  created_at?: number;
  owner?: string;
  role?: string;
};

export type RepoRow = {
  repo: string;
  name: string;
  /** Another account's repository this account is a member of: `owner · role`. */
  shared?: string;
};

export function repoRows(platform: PlatformRepo[]): RepoRow[] {
  return platform
    .map((repo) => ({
      repo: repo.id,
      name: repo.name || repo.id,
      shared: repo.role && repo.role !== 'owner' ? `${repo.owner} · ${repo.role}` : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
}
