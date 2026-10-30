// How the app names the accounts and principals it shows. Accounts made before email-only
// sign-up are named by their email address, and an email address is never shown to someone who
// may not see it: inside a repository only its members see one; everyone else (and every page
// outside a repository, such as Explore) sees "member" in its place.
import { createContext, useContext } from 'react';

/** What stands in for an email-named account where its address may not be shown. */
export const HIDDEN_ACCOUNT = 'member';

const EMAIL = /[^\s:@/]+@[^\s:@/]+\.[^\s:@/]+/g;

/**
 * Whether the page may show email-named accounts as they are. False unless a repository page
 * says its viewer is a member, so a page that never sets it hides every address.
 */
export const ShowEmailsContext = createContext(false);

/** An account as people read it: its name, or HIDDEN_ACCOUNT for an email unless `showEmails`. */
export const accountName = (account: string, showEmails = false) =>
  showEmails ? account : account.replace(EMAIL, HIDDEN_ACCOUNT);

/**
 * A principal as people read it: `user:ada` → `ada`, `token:ci` → `ci (token)`, anything else
 * as it is; an email address in it becomes HIDDEN_ACCOUNT unless `showEmails`.
 */
export function principalName(principal: string, showEmails = false): string {
  const [kind, ...rest] = principal.split(':');
  const name = rest.join(':');
  const shown =
    name && kind === 'user' ? name : name && kind === 'token' ? `${name} (token)` : principal;
  return accountName(shown, showEmails);
}

/** principalName and accountName for this page's viewer. */
export function usePeople() {
  const showEmails = useContext(ShowEmailsContext);
  return {
    principal: (principal: string) => principalName(principal, showEmails),
    account: (account: string) => accountName(account, showEmails),
  };
}
