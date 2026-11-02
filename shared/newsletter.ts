// The Flight log sign-up's one rule both sides need (cloudflare/worker/platform-newsletter.ts and
// the `/updates` form).
import { normalizeAccountIdentifier } from './account';

/** A valid address to mail, normalized, or null: the account rules, and no leading `=`, `+` or
 * `-`, which a spreadsheet opening the export would run as a formula. */
export function subscriberEmail(value: unknown) {
  const email = typeof value === 'string' ? normalizeAccountIdentifier(value) : null;
  return email?.includes('@') && /^[a-z0-9]/.test(email) ? email : null;
}
