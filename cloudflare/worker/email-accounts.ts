// Password accounts made from an email address. The address is private: the account is named
// by a public handle made from the address's local part (cleaned, then numbered or suffixed
// until free), and the address is claimed on its own claim instance (`email:<sha256>`, the
// one provider sign-in uses for verified emails) so it signs in to that handle. Accounts made
// earlier keep their names: a plain username, or an account named by an address.
import { normalizeAccountIdentifier } from '../../shared/account';
import { contactEmail } from './account-email';
import { accountExists, claims, emailKey, emailTaken, holder, PENDING_MS } from './oauth-identity';
import type { Env, Json } from './types';
import { workspace } from './workspace';

const MAX_HANDLE = 32;
const SIGNUP_EMAIL = 'Sign up with your email address';

/** The address a sign-up uses: `email`, or an address sent as `username` by older clients. */
export function signupEmail(body: Json): string {
  const named = typeof body.username === 'string' ? body.username.trim() : '';
  if (named && !named.includes('@'))
    throw Object.assign(new Error(`${SIGNUP_EMAIL}; your public name is made from it`), {
      code: 'EMAIL_REQUIRED',
    });
  const value = typeof body.email === 'string' && body.email.trim() ? body.email : named;
  if (!value) throw Object.assign(new Error(SIGNUP_EMAIL), { code: 'EMAIL_REQUIRED' });
  const email = contactEmail(value);
  if (named && normalizeAccountIdentifier(named) !== email)
    throw Object.assign(new Error('Send one email address'), { code: 'EMAIL_REQUIRED' });
  return email;
}

/** Handles to try for an address: its cleaned local part, then numbered, then random. */
export function handlesFor(email: string): string[] {
  let base = email
    .slice(0, email.indexOf('@'))
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `user_${base}`.replace(/_+$/, '');
  if (base.length < 3) base = `${base}_user`;
  const withSuffix = (stem: string, suffix: string) =>
    `${stem.slice(0, MAX_HANDLE - suffix.length).replace(/_+$/, '')}${suffix}`;
  const numbered = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => withSuffix(base, String(n)));
  const random = [0, 1, 2].map(() => {
    const [a, b] = crypto.getRandomValues(new Uint8Array(2));
    return withSuffix(
      base,
      `_${a.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
    );
  });
  return [withSuffix(base, ''), ...numbered, ...random].filter(
    (name) => normalizeAccountIdentifier(name) === name,
  );
}

/**
 * Creates the account for `email` under the first free handle and claims the address for it.
 * `signup` is the account authority's sign-up command without its `username`.
 */
export async function signUpWithEmail(env: Env, email: string, signup: Json): Promise<Json> {
  const inUse = () =>
    Object.assign(new Error('An account already uses this email address'), {
      code: 'EMAIL_IN_USE',
    });
  if (await emailTaken(env, email)) throw inUse();
  const key = await emailKey(email);
  const held = await holder(env, key);
  // A young claim without its account is another sign-up creating it right now.
  if (held && Date.now() - held.claimed_at < PENDING_MS) throw inUse();
  let replace = held !== null;
  for (const name of handlesFor(email)) {
    if (await accountExists(env, name)) continue;
    const claimed = await claims(env, key, { op: 'identity_claim', account: name, replace });
    if (!claimed.claimed) throw inUse();
    replace = true;
    try {
      return await workspace(env, name, { ...signup, username: name, email });
    } catch (e: any) {
      if (e?.code === 'ALREADY_EXISTS') continue;
      await claims(env, key, { op: 'identity_claim_release', account: name }).catch(() => {});
      throw e;
    }
  }
  throw Object.assign(new Error('No free name for this email address; try again'), {
    code: 'UNAVAILABLE',
  });
}

/** The account a sign-in names: a username, an account named by an address, or the handle an
 * address was claimed for. An unknown address stays as given, so it fails like a wrong name. */
export async function accountFor(env: Env, identifier: string): Promise<string> {
  if (!identifier.includes('@') || (await accountExists(env, identifier))) return identifier;
  const held = await holder(env, await emailKey(identifier));
  return held?.account ?? identifier;
}
