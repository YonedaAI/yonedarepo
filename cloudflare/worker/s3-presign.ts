// Presigned S3 URLs (AWS Signature Version 4, query-string auth) for R2's S3 API, so a
// client moves object bytes to or from R2 directly, never through a Worker body. The key
// pair is an R2 API token's S3 credentials, held only in Worker secrets; a URL grants one
// method on one key until it expires. Headers listed in `headers` are signed, so a client
// must send them exactly (R2 then checks an `x-amz-checksum-sha256` against the bytes).
import { toHex } from './hmac';

export type S3Credentials = {
  /** `https://<account>.r2.cloudflarestorage.com` (path-style: `/<bucket>/<key>`). */
  endpoint: string;
  /** Omitted when the endpoint's host names the bucket (virtual-hosted style). */
  bucket?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 signs in region `auto`. */
  region?: string;
};

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(data));
}

const sha256Hex = async (data: string) =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));

/** RFC 3986 encoding as SigV4 wants it (`/` kept in paths). */
function encode(value: string, keepSlash = false) {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/** `20130524T000000Z` */
const amzDate = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** A presigned URL for `method` on `key`, valid for `expiresIn` seconds from `at`. The
 * caller sends `headers` (signed) with its request. */
export async function presign(
  creds: S3Credentials,
  method: 'GET' | 'PUT',
  key: string,
  expiresIn: number,
  headers: Record<string, string> = {},
  at = new Date(),
): Promise<string> {
  const region = creds.region ?? 'auto';
  const url = new URL(creds.endpoint);
  const path = `${creds.bucket ? `/${encode(creds.bucket)}` : ''}/${encode(key, true)}`;
  const datetime = amzDate(at);
  const date = datetime.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const signed: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(headers)) signed[name.toLowerCase()] = value.trim();
  const names = Object.keys(signed).sort();
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${creds.accessKeyId}/${scope}`],
    ['X-Amz-Date', datetime],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', names.join(';')],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${signed[n]}\n`).join(''),
    names.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', datetime, scope, await sha256Hex(canonical)].join('\n');
  let signingKey = await hmac(encoder.encode(`AWS4${creds.secretAccessKey}`), date);
  for (const part of [region, 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
  const signature = toHex(await hmac(signingKey, toSign));
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
