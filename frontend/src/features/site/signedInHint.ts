import { SIGNED_IN_HINT } from './siteRoute';

/** A request hint only: fresh session discovery and API authorization decide admission. */
export const PERSONAL_WORKSPACE_HINT = 'yoneda-personal-workspace';

export function personalWorkspaceHint(value: string | null) {
  try {
    if (value) window.localStorage.setItem(PERSONAL_WORKSPACE_HINT, value);
    else window.localStorage.removeItem(PERSONAL_WORKSPACE_HINT);
  } catch {
    // Storage is optional; normal authenticated discovery remains available.
  }
}

/** A display hint for the home route. */
export function signedInHint(value?: boolean): boolean {
  try {
    if (value === true) window.localStorage.setItem(SIGNED_IN_HINT, '1');
    else if (value === false) window.localStorage.removeItem(SIGNED_IN_HINT);
    return window.localStorage.getItem(SIGNED_IN_HINT) === '1';
  } catch {
    return false;
  }
}
