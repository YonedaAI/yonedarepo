// What the browser offers a repository's viewer. A public repository is readable by anyone,
// signed in or not; a viewer who reads only because of that (`viewer.public`) gets the read
// views and nothing else. The server decides every request; this only hides controls it
// would refuse.
import { createContext, useContext } from 'react';
import type { Viewer } from './RepoMembers';

export type Visibility = 'private' | 'public';

export type RepoAccess = {
  /** Read views only: no write, review, land, comment, rebase or recovery controls. */
  readOnly: boolean;
  /** The Settings tab and owner links: the owner and admins. */
  settings: boolean;
  /** Changing visibility: the owning account (or an owner of the owning org), not admins. */
  visibility: boolean;
  /** Fork: any signed-in account that can read (a fork needs an owner). */
  fork: boolean;
};

/**
 * The controls `viewer` gets. Until the status says who is asking (`viewer` undefined) the
 * page offers nothing beyond reading, so no control flashes up only to vanish.
 */
export function repoAccess(viewer: Viewer | undefined, authenticated: boolean): RepoAccess {
  const member = Boolean(authenticated && viewer && !viewer.public);
  const manages = member && viewer?.owner === true;
  return {
    readOnly: !member,
    settings: manages,
    visibility: manages && !viewer?.role,
    fork: authenticated && viewer !== undefined,
  };
}

/** Whether the repository is public; an older server's status without the field is private. */
export const isPublic = (visibility: Visibility | undefined) => visibility === 'public';

/**
 * Read-only mode for everything inside a repository page. Deep controls (comment composers,
 * review and land buttons, rebase, break-glass, open change) read it instead of threading a
 * prop through every view. Outside a repository page it is false: nothing changes.
 */
export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);
