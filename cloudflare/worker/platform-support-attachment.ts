// Contact support's one optional attachment, as the browser sends it: `{name, type, data}`,
// the file's base64 inside the JSON request (about 6.7 MB for the largest, under the request
// sizes the API already takes). Everything about it is untrusted, so its type comes from its
// bytes: a declared type must agree with them, and the file name is rebuilt to one Resend
// accepts, whose extension fits that type.
import {
  SUPPORT_ATTACHMENT_BYTES,
  SUPPORT_ATTACHMENT_HELP,
  SUPPORT_ATTACHMENT_TOO_LARGE,
  SUPPORT_ATTACHMENT_TYPES,
  SUPPORT_TEXT_TYPES,
} from '../../shared/support';
import { ApiError, type Json } from './repo-ops';
import { fromBase64 } from './repo-stores';

export type Attachment = { filename: string; content: string; content_type: string; bytes: number };

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** The request body the largest attachment and message fit in. */
export const SUPPORT_BODY_LIMIT = base64Length(SUPPORT_ATTACHMENT_BYTES) + 64 * 1024;

const SIGNATURES: [string, (bytes: Uint8Array) => boolean][] = [
  ['image/png', (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', (b) => starts(b, [0xff, 0xd8, 0xff])],
  ['image/gif', (b) => /^GIF8[79]a/.test(ascii(b, 0, 6))],
  ['image/webp', (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
  ['application/pdf', (b) => ascii(b, 0, 5) === '%PDF-'],
];
const starts = (bytes: Uint8Array, prefix: number[]) => prefix.every((v, i) => bytes[i] === v);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

function isText(bytes: Uint8Array) {
  try {
    return !new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).includes('\0');
  } catch {
    return false;
  }
}
const typeOf = (bytes: Uint8Array) =>
  SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? (isText(bytes) ? 'text/plain' : null);

function decode(data: string) {
  try {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? fromBase64(data) : null;
  } catch {
    return null;
  }
}

/** `name` without its path or any character a mail header could trip on, ending in an
 * extension of `type`. */
function fileName(name: string, type: string) {
  const extensions = SUPPORT_ATTACHMENT_TYPES[type];
  const safe = (name.split(/[\\/]/).pop() ?? '')
    .replace(/[^\p{L}\p{N} ._()-]+/gu, '_')
    .replace(/^[. ]+/, '')
    .slice(-100)
    .trim();
  const extension = safe.split('.').pop()?.toLowerCase() ?? '';
  if (safe.includes('.') && extensions.includes(extension)) return safe;
  return `${safe || 'attachment'}.${extensions[0]}`;
}

/** The attachment `value` describes, or null without one. Refuses what is not an allowed file
 * of the type it claims, or over the size limit, with INVALID_INPUT. */
export function attachmentOf(value: unknown): Attachment | null {
  if (value === undefined || value === null) return null;
  const { name, type, data } = (typeof value === 'object' ? value : {}) as Json;
  if (typeof name !== 'string' || typeof type !== 'string' || typeof data !== 'string')
    throw new ApiError('INVALID_INPUT', SUPPORT_ATTACHMENT_HELP);
  if (data.length > base64Length(SUPPORT_ATTACHMENT_BYTES))
    throw new ApiError('INVALID_INPUT', SUPPORT_ATTACHMENT_TOO_LARGE);
  const bytes = decode(data);
  if (!bytes?.length) throw new ApiError('INVALID_INPUT', SUPPORT_ATTACHMENT_HELP);
  if (bytes.length > SUPPORT_ATTACHMENT_BYTES)
    throw new ApiError('INVALID_INPUT', SUPPORT_ATTACHMENT_TOO_LARGE);
  const actual = typeOf(bytes);
  const declared = type.split(';')[0].trim().toLowerCase();
  const agrees =
    actual === 'text/plain' ? SUPPORT_TEXT_TYPES.includes(declared) : actual === declared;
  if (!actual || !agrees) throw new ApiError('INVALID_INPUT', SUPPORT_ATTACHMENT_HELP);
  return {
    filename: fileName(name, actual),
    content: data,
    content_type: actual,
    bytes: bytes.length,
  };
}
