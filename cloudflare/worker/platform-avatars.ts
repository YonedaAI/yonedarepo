// Account pictures on the platform API. `GET /api/v1/avatars/<name>` (public) and
// `GET /api/v1/account/avatar` (the signed-in person's own) serve an upload's bytes from R2
// with the type the account authority recorded and `nosniff`, or redirect to the
// provider's picture on its own image host; the platform never fetches one.
// `PUT /api/v1/account/avatar` uploads (PNG, JPEG or WebP, at most 1 MiB: the authority
// types it by its leading bytes) and `DELETE` removes it, falling back to the provider's.
import { type AvatarInfo, isPublicHandle, ownAvatarUrl } from './avatars';
import { error, response } from './http';
import { ApiError, type Credentials, type Json } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

export const MAX_AVATAR_BYTES = 1024 * 1024;
const PUBLIC = /^\/api\/v1\/avatars\/([^/]+)$/;
const OWN = '/api/v1/account/avatar';
/** Pictures change rarely and their URLs carry a version; five minutes bounds a stale one. */
const MAX_AGE = 300;

/** The account a public picture URL names, or undefined when it is not one. */
export function publicAvatarName(url: URL): string | null | undefined {
  const match = PUBLIC.exec(url.pathname);
  if (!match) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return isPublicHandle(name) ? name : null;
}

export const isOwnAvatar = (url: URL) => url.pathname === OWN;

/** `GET /api/v1/avatars/<name>`: anyone's picture; no picture, no account and an
 * email-named account all answer 404 alike. */
export async function servePublicAvatar(env: Env, name: string | null): Promise<Response> {
  if (!name) return none();
  return serve(env, name, 'public');
}

/** `/api/v1/account/avatar` for a signed-in person: their picture, an upload or a removal. */
export async function ownAvatar(req: Request, env: Env, auth: Credentials): Promise<Response> {
  if (!('_session' in auth) || !auth._session.human)
    return error('UNAUTHORIZED', 'Sign in to your account to change its picture', 401);
  const account = auth._session.workspace;
  if (req.method === 'GET') return serve(env, account, 'private');
  if (req.method === 'PUT') return upload(req, env, account);
  if (req.method === 'DELETE') {
    const removed = await workspace(env, account, { op: 'avatar_remove' });
    if (removed.previous_key) await env.OBJECTS.delete(String(removed.previous_key));
    return pictureNow(env, account);
  }
  return error('NOT_FOUND', 'Unknown API path', 404);
}

async function serve(env: Env, account: string, scope: 'public' | 'private') {
  const where = await workspace(env, account, { op: 'avatar_serve' }).catch((e) => {
    if (e?.code === 'NOT_FOUND') return {} as Json;
    throw e;
  });
  const cache = `${scope}, max-age=${MAX_AGE}`;
  if (typeof where.provider_url === 'string')
    return new Response(null, {
      status: 302,
      headers: { location: where.provider_url, 'cache-control': cache },
    });
  const upload = where.upload;
  if (!upload) return none();
  const object = await env.OBJECTS.get(String(upload.key));
  if (!object) return none();
  return new Response(object.body, {
    headers: {
      // The type the authority read from the bytes, never one a client named.
      'content-type': String(upload.content_type),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'cache-control': cache,
      etag: `"${upload.digest}"`,
    },
  });
}

const none = () => {
  const answer = error('NOT_FOUND', 'No picture', 404);
  answer.headers.set('cache-control', `public, max-age=${MAX_AGE}`);
  return answer;
};

async function upload(req: Request, env: Env, account: string) {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_AVATAR_BYTES) return tooLarge();
  const bytes = await readBytes(req, MAX_AVATAR_BYTES);
  if (!bytes) return tooLarge();
  const hex = (b: Uint8Array) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const stored = await workspace(env, account, {
    op: 'avatar_upload',
    head: hex(bytes.subarray(0, 16)),
    size: bytes.byteLength,
    digest,
  }).catch((e) => {
    throw new ApiError(e?.code ?? 'INVALID_INPUT', e?.message);
  });
  try {
    await env.OBJECTS.put(String(stored.key), bytes, {
      httpMetadata: { contentType: String(stored.content_type) },
    });
  } catch (e) {
    // The record names bytes that never arrived: take it back (only if still this upload).
    await workspace(env, account, { op: 'avatar_remove', digest }).catch(() => {});
    throw e;
  }
  if (stored.previous_key) await env.OBJECTS.delete(String(stored.previous_key)).catch(() => {});
  return pictureNow(env, account);
}

async function pictureNow(env: Env, account: string) {
  const info = (await workspace(env, account, { op: 'avatar_get' })) as AvatarInfo;
  return response({ avatar_url: ownAvatarUrl(info), avatar_source: info.source });
}

const tooLarge = () => error('TOO_LARGE', 'Use a picture of at most 1 MB', 413);

/** The body's bytes, or null past `limit` (read no further). */
async function readBytes(req: Request, limit: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
