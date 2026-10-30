// Transport/browser counterpart of yoneda-core::account; parity cases live beside the Rust contract.
import { accountSchema } from './contracts/account';
import { reservedHandlesSchema } from './contracts/reserved-handles';

export type { AccountIdentifier } from './contracts/account';
export const ACCOUNT_IDENTIFIER_HELP = accountSchema.description;
export const MAX_ACCOUNT_IDENTIFIER_LENGTH = accountSchema.maxLength;

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

/** Names no handle may take: the site's and the app's top-level paths
 * (`yoneda_core::account::RESERVED_HANDLES`). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(reservedHandlesSchema.enum);

export const isReservedHandle = (name: string) => RESERVED_HANDLES.has(name);

/** A handle as URLs carry it (`/<handle>`): a username's shape, lowercased, never an email
 * address or a reserved name; null when `value` is none. */
export function normalizeHandle(value: string): string | null {
  const name = normalizeAccountIdentifier(value);
  return name && !name.includes('@') && !isReservedHandle(name) ? name : null;
}
