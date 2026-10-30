// A profile (`/<handle>`): a person or an organization and its public repositories, as the
// platform's `GET /profiles/<handle>` answers. Fields it may not send are optional, and the
// page shows only what it got.

export type ProfileRepo = {
  id: string;
  name: string;
  created_at?: number;
  /** Its readable address, `/<handle>/<name>`. */
  path?: string | null;
  /** Absent: public (a profile lists public repositories). */
  visibility?: 'public' | 'private';
  description?: string | null;
  last_landed_at?: number | null;
  pinned?: boolean;
};

export type Profile = {
  handle: string;
  kind: 'user' | 'org';
  display_name?: string | null;
  avatar_url?: string | null;
  repositories: ProfileRepo[];
};

export type ProfileTab = 'overview' | 'repositories';

export const profilePath = (handle: string) => `/profiles/${handle}`;

/** The name a profile goes by: its display name, else its handle. */
export const profileName = (p: Profile) => p.display_name?.trim() || p.handle;

/** The letter shown when a profile has no avatar. */
export const profileInitial = (p: Profile) => profileName(p).charAt(0).toUpperCase();

/** When a repository last changed, as far as the profile says: its last landing, else its creation. */
export const lastActive = (r: ProfileRepo) => r.last_landed_at ?? r.created_at;

/**
 * The overview's cards: the pinned repositories when any are pinned, else the most recently
 * active (unknown last, then by name), at most `limit`.
 */
export function topRepos(repos: ProfileRepo[], limit = 6): ProfileRepo[] {
  const pinned = repos.filter((r) => r.pinned);
  if (pinned.length) return pinned.slice(0, limit);
  return [...repos]
    .sort((a, b) => (lastActive(b) ?? -1) - (lastActive(a) ?? -1) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
