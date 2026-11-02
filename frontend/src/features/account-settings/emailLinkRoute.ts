// The pages an account email links to, signed in or out: the address's confirmation
// (`/verify-email?account=…&token=…`, opened by a click that confirms nothing) and the password
// reset (`/reset-password#account=…&token=…`). The reset link's parts come from the fragment and
// are never formatted back into an address, so its token leaves the URL with the first replace.
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
  const link = root === 'verify-email' ? params : new URLSearchParams(hash.slice(1));
  return { view: root, account: link.get('account') ?? '', token: link.get('token') ?? '' };
}

export const isEmailLink = (route: { view: string }): route is EmailLinkRoute =>
  route.view === 'verify-email' || route.view === 'reset-password';

export const emailLinkTitle = (route: EmailLinkRoute) =>
  route.view === 'verify-email' ? 'Confirm your email' : 'Set a new password';

export function formatEmailLink(route: EmailLinkRoute) {
  if (route.view === 'reset-password') return '/reset-password';
  return `/verify-email?account=${encodeURIComponent(route.account)}&token=${encodeURIComponent(route.token)}`;
}
