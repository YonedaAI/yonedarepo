// Transport/browser counterpart of yoneda-core::account; parity cases live beside the Rust contract.
export const ACCOUNT_IDENTIFIER_HELP =
  'Use a username (3–32 letters, digits or underscores, starting with a letter) or an email address';
export const MAX_ACCOUNT_IDENTIFIER_LENGTH = 254;

export function normalizeAccountIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_ACCOUNT_IDENTIFIER_LENGTH) return null;
  for (const character of trimmed) if (character.charCodeAt(0) > 127) return null;
  const name = trimmed.toLowerCase();
  if (!name.includes('@')) return /^[a-z][a-z0-9_]{2,31}$/.test(name) ? name : null;
  const parts = name.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    !domain.includes('.') ||
    !domain
      .split('.')
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    return null;
  return name;
}

export function isValidAccountIdentifier(value: string): boolean {
  return normalizeAccountIdentifier(value) !== null;
}

export function isCanonicalAccountIdentifier(value: string): boolean {
  return normalizeAccountIdentifier(value) === value;
}

// Keep legacy username segments unchanged while escaping email dots and cookie/token separators.
export function encodeAccountIdentifier(value: string): string {
  if (!isCanonicalAccountIdentifier(value)) throw new Error(ACCOUNT_IDENTIFIER_HELP);
  return encodeURIComponent(value).replace(
    /[.!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function decodeAccountIdentifier(value: string): string | null {
  if (value.length > MAX_ACCOUNT_IDENTIFIER_LENGTH * 3) return null;
  try {
    const decoded = decodeURIComponent(value);
    return isCanonicalAccountIdentifier(decoded) && encodeAccountIdentifier(decoded) === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}
