// The handle an email-named account picks once (`PUT /api/auth/handle`): its address on the
// site (`/<handle>`, `/<handle>/<repository>`). Accounts named by a username already have one.
import type { AccountIdentity } from '../../lib/types';
import { HANDLE } from '../source-platform/repoNames';

export const HANDLE_HELP = '3–32 lowercase letters, digits or underscores, starting with a letter.';

/** Whether to ask this account for a handle: email-named, and the server says it has none. */
export const needsHandle = (identity: AccountIdentity | null | undefined) =>
  Boolean(identity?.username.includes('@') && identity.handle === null);

/** What is wrong with `value` as a handle before asking the server, or '' when nothing is. */
export function handleProblem(value: string): string {
  if (!value) return '';
  if (value !== value.toLowerCase()) return 'Use lowercase letters.';
  if (!HANDLE.test(value)) return `Handles are ${HANDLE_HELP}`;
  return '';
}

export type Availability = 'unknown' | 'checking' | 'available' | 'taken';

/** The server's refusal of a handle, as the picker says it. */
export function handleRefusal(code: string, handle: string, message: string): string {
  if (code === 'HANDLE_TAKEN') return `${handle} is taken. Try another.`;
  if (code === 'HANDLE_RESERVED') return `${handle} is reserved for the site's own pages.`;
  if (code === 'HANDLE_INVALID') return `Handles are ${HANDLE_HELP}`;
  if (code === 'HANDLE_FIXED') return 'This account already has a handle.';
  return message;
}
