// A repository's visibility as Settings changes it (`PUT /repos/:id/visibility`). Private is
// the default; public lets anyone read and never lets anyone write. Every change is confirmed,
// and going public says exactly what becomes readable.
import type { Visibility } from '../source-platform/repoAccess';

export const VISIBILITIES: readonly Visibility[] = ['private', 'public'];

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: 'Private',
  public: 'Public',
};

/** One line each, shared by the New repository dialog and Settings. */
export const VISIBILITY_HELP: Record<Visibility, string> = {
  private: 'Only the owner and members can see or clone it.',
  public: 'Anyone can read and clone it, even without an account. Only members can change it.',
};

/** What a visitor gains when a repository goes public (shown before confirming). */
export const PUBLIC_WARNING =
  'Anyone, including people without an account, can read its code, history, changes, ' +
  'releases and LFS files, and clone it. Nobody gains write access: members and their roles ' +
  'stay as they are.';

export const PRIVATE_NOTE =
  'Only the owner and members will be able to see or clone it. Existing forks owned by other ' +
  'accounts stay theirs.';

export const visibilityRequest = (repo: string, next: Visibility) => ({
  path: `/repos/${repo}/visibility`,
  method: 'PUT' as const,
  body: { visibility: next },
});

export const otherVisibility = (current: Visibility): Visibility =>
  current === 'public' ? 'private' : 'public';

/** The confirm step for moving to `next`: its title, what it means and the button. */
export function visibilityConfirm(next: Visibility, name: string) {
  return next === 'public'
    ? { title: `Make ${name} public?`, body: PUBLIC_WARNING, action: 'Make public' }
    : { title: `Make ${name} private?`, body: PRIVATE_NOTE, action: 'Make private' };
}

/** A refused change in words: an admin (403) is told who can make it. */
export function visibilityError(error: { status?: number; message: string }) {
  return error.status === 403
    ? 'Only the repository owner (or an owner of its organization) can change its visibility.'
    : error.message;
}
