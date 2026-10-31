// The account's repositories as rows: every platform repository it can use, by name, for the
// picker and the Repositories page. A public one carries a badge; other accounts' public
// repositories are on Explore, and in the picker only as favorites.
import type { Visibility } from '../source-platform/repoAccess';

/** `GET /api/v1/repos`: `role` is `owner` for the account's own repositories. */
export type PlatformRepo = {
  id: string;
  name: string;
  created_at?: number;
  owner?: string;
  /** The owner's handle (its readable address `/<handle>/<name>`); null while it has none. */
  owner_handle?: string | null;
  role?: string;
  visibility?: Visibility;
};

export type RepoRow = {
  repo: string;
  name: string;
  /** Another account's repository this account is a member of: `owner · role`. */
  shared?: string;
  /** Its owner, by handle where it has one. */
  owner?: string;
  /** That owner is the viewer: the row shows its name alone. */
  own?: boolean;
  /** Anyone may read it. */
  public?: boolean;
};

/** A row's spoken name: "acme, ada · write, public", never its small labels run together. */
export const rowLabel = (row: RepoRow) => {
  const labels = [row.shared, row.public ? 'public' : undefined].filter(Boolean);
  return labels.length ? `${row.name}, ${labels.join(', ')}` : undefined;
};

/** `self`: the viewer's own names. */
export function repoRows(
  platform: PlatformRepo[],
  self: (string | null | undefined)[] = [],
): RepoRow[] {
  return platform
    .map((repo) => {
      const owner = repo.owner_handle ?? repo.owner;
      return {
        repo: repo.id,
        name: repo.name || repo.id,
        shared: repo.role && repo.role !== 'owner' ? `${owner} · ${repo.role}` : undefined,
        ...(owner ? { owner } : {}),
        ...(owner && self.includes(owner) ? { own: true } : {}),
        ...(repo.visibility === 'public' ? { public: true } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo));
}

/** The rows for `query`: `owner/name` containing it, any case, in listing order. */
export function matchRows(rows: RepoRow[], query: string): RepoRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      `${r.owner ?? ''}/${r.name}`.toLowerCase().includes(q) ||
      (r.shared ?? '').toLowerCase().includes(q),
  );
}
