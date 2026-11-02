// A provider callback's outcome in the address.
import { continueToGitHub } from '../source-platform/importModel';
import { type AuthResult, readAuthResult, withoutAuthResult } from './oauthModel';

let authResult: AuthResult | null | undefined;

/** The outcome, read once (per page load) and then dropped from the address. */
export function takeAuthResult() {
  if (authResult !== undefined || typeof window === 'undefined') return authResult ?? null;
  authResult = readAuthResult(window.location.search);
  if (authResult)
    window.history.replaceState(
      null,
      '',
      withoutAuthResult(window.location.pathname, window.location.search),
    );
  if (authResult && 'linked' in authResult) continueToGitHub();
  return authResult;
}
