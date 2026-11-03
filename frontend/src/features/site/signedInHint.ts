import { SIGNED_IN_HINT } from './siteRoute';

/** A display hint for the home route; fresh session discovery still decides admission. */
export function signedInHint(value?: boolean): boolean {
  try {
    if (value === true) window.localStorage.setItem(SIGNED_IN_HINT, '1');
    else if (value === false) window.localStorage.removeItem(SIGNED_IN_HINT);
    return window.localStorage.getItem(SIGNED_IN_HINT) === '1';
  } catch {
    return false;
  }
}
