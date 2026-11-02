// The value that carries an organization's installation from the platform, which read it, to the
// sign-in Worker, which proves an owner. It names the account and a random secret; the account's
// store keeps only the secret's hash, for ten minutes, once (`github_org_ticket_*`). It sits in a
// URL, so the account is encoded: an email-named account's address stays out of the address bar.

const SECRET = /^[a-f0-9]{64}$/;

export function newTicket(account: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { secret, value: `${btoa(encodeURIComponent(account)).replaceAll('=', '')}.${secret}` };
}

export function readTicket(value: string | null) {
  const [name, secret] = (value ?? '').split('.');
  if (!name || !secret || !SECRET.test(secret)) return null;
  try {
    return { account: decodeURIComponent(atob(name)), secret };
  } catch {
    return null;
  }
}
