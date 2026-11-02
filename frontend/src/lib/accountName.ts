// What the app calls the signed-in person: their name, then their handle, then a username that
// is not an email address. An address never shows here, so a screenshot of the app can't leak it.
import type { AccountIdentity } from './types';

type Named = Pick<AccountIdentity, 'username' | 'handle' | 'display_name'>;

/** Undefined when the account has nothing to go by but an email address. */
export function accountName(identity: Named | null | undefined) {
  if (identity?.display_name) return identity.display_name;
  if (identity?.handle) return identity.handle;
  return identity?.username.includes('@') ? undefined : identity?.username;
}

/** The greeting's name: the first word of a name, or a whole handle. */
export const firstName = (identity: Named | null | undefined) =>
  identity?.display_name?.split(/\s+/)[0] || accountName(identity);
