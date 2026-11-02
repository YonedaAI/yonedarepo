// The pages an account email links to, signed in or out: the address's confirmation
// (`/verify-email`, opened by a click that confirms nothing) and the password reset
// (`/reset-password`). A link's parts ride in the fragment, which reaches no server, and are
// never formatted back into an address, so the token leaves the URL with the first replace.
// A confirmation link emailed before the fragment has them in its query, for its 24 hours.
export type EmailLinkRoute =
  | { view: 'verify-email'; account: string; token: string }
  | { view: 'reset-password'; account: string; token: string };

/** The route `root` opens, if it is one of these pages. */
export function parseEmailLink(
  root: string,
  params: URLSearchParams,
  hash: string,
): EmailLinkRoute | null {
  if (root !== 'verify-email' && root !== 'reset-password') return null;
  const fragment = new URLSearchParams(hash.slice(1));
  const link = root === 'verify-email' && !fragment.has('token') ? params : fragment;
  return { view: root, account: link.get('account') ?? '', token: link.get('token') ?? '' };
}

export const isEmailLink = (route: { view: string }): route is EmailLinkRoute =>
  route.view === 'verify-email' || route.view === 'reset-password';

export const emailLinkTitle = (route: EmailLinkRoute) =>
  route.view === 'verify-email' ? 'Confirm your email' : 'Set a new password';

export const formatEmailLink = (route: EmailLinkRoute) => `/${route.view}`;
