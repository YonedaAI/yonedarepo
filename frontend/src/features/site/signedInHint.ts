import { SIGNED_IN_HINT } from './siteRoute';

/** A display hint for the home route. */
export function signedInHint(value?: boolean): boolean {
  try {
    // Remove the retired personal-workspace hint on session discovery or logout.
    if (value !== undefined) window.localStorage.removeItem('yoneda-personal-workspace');
    if (value === true) window.localStorage.setItem(SIGNED_IN_HINT, '1');
    else if (value === false) window.localStorage.removeItem(SIGNED_IN_HINT);
    return window.localStorage.getItem(SIGNED_IN_HINT) === '1';
  } catch {
    return false;
  }
}
