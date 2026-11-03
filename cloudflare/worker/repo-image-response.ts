// A private browser may reuse an image's bytes only after the ordinary repository route
// has read and authorized the current representation. Never cache an admission decision.
import { imageType, MAX_IMAGE_BYTES } from '../../shared/raster-image';
import { response } from './http';
import type { Json } from './repo-ops';

function raster(value: Json) {
  if (
    value.encoding !== 'base64' ||
    typeof value.content !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_IMAGE_BYTES
  )
    return false;
  try {
    const prefix = Uint8Array.from(atob(value.content.slice(0, 32)), (c) => c.charCodeAt(0));
    return imageType(prefix) !== null;
  } catch {
    return false;
  }
}

/** Weak comparison is appropriate for GET and survives negotiated compression. */
const matches = (condition: string | null, etag: string) =>
  condition?.split(',').some((part) => {
    const tag = part.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, '');
  }) ?? false;

/** `read` includes the existing grant, withholding, credentials and privacy path. */
export async function imageAnswer(req: Request, read: (request: Request) => Promise<Json>) {
  // Internal regional hops consume JSON, so only this outer HTTP boundary may answer 304.
  const admittedHeaders = new Headers(req.headers);
  admittedHeaders.delete('if-none-match');
  const value = await read(new Request(req, { headers: admittedHeaders }));
  if (!raster(value)) return response(value);
  const body = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const etag = `W/"image-v1-${hash}"`;
  const headers = {
    'cache-control': 'private, no-cache, must-revalidate',
    vary: 'Cookie, Authorization',
    etag,
    'content-type': 'application/json; charset=utf-8',
  };
  return matches(req.headers.get('if-none-match'), etag)
    ? new Response(null, { status: 304, headers })
    : new Response(body, { headers });
}
