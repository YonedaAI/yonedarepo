// Releases: the adapter half. The authority owns releases and their asset records
// (repo_store/releases.rs); this module routes the operations and moves asset bytes. An
// upload is read whole (within the cap), hashed, checked by a dry run of the record, written
// to R2 under the repository's platform prefix (so the repository purge removes it) at a
// key named by its sha256, and only then recorded with its size and sha256. Concurrent
// first uploads of one name write different keys (unless their bytes are equal) and only
// one is recorded, so a download, which streams the key the record names, always serves
// the recorded bytes, sent with that sha256 in `x-yoneda-sha256`.
import { notifyHooks } from './repo-hooks';
import { fromBase64, toBase64 } from './repo-objects';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

/** As releases.rs MAX_ASSET_BYTES: an upload is held whole to hash it. */
export const ASSET_BYTES = 25 * 1024 * 1024;
/** MCP carries asset bytes as base64 in JSON; larger assets use REST. */
const MCP_ASSET_BYTES = 4 * 1024 * 1024;

export const assetKey = (repo: string, tag: string, sha256: string, name: string) =>
  `platform/v1/${repo}/release/${tag}/${sha256}/${name}`;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** After an event the authority queued: deliver it (and anything else waiting). */
async function notified(ctx: RepoContext, done: Promise<Json>) {
  const value = await done;
  await notifyHooks(ctx.env, ctx.repo);
  return value;
}

/** The request body, refused past the asset cap. */
async function bodyBytes(body: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > ASSET_BYTES)
      throw new ApiError('TOO_LARGE', `A release asset is at most ${ASSET_BYTES} bytes`);
    parts.push(chunk);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Stores `bytes` as asset `name` of the release for `tag` and records it. */
export async function uploadAsset(
  ctx: RepoContext,
  tag: unknown,
  name: unknown,
  bytes: Uint8Array,
  contentType: unknown,
): Promise<Json> {
  if (bytes.length > ASSET_BYTES)
    throw new ApiError('TOO_LARGE', `A release asset is at most ${ASSET_BYTES} bytes`);
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const record = {
    op: 'repo_release_asset_put',
    tag,
    name,
    size: bytes.length,
    sha256,
    content_type: typeof contentType === 'string' && contentType ? contentType : null,
  };
  // Refused before anything is written: no release, a taken name, a cap reached.
  const checked = await ctx.call({ ...record, dry_run: true });
  const key = assetKey(ctx.repo, checked.tag, sha256, checked.name);
  await ctx.env.OBJECTS.put(key, bytes, {
    sha256,
    httpMetadata: { contentType: checked.content_type },
  });
  try {
    return await ctx.call(record);
  } catch (e) {
    // Another upload took the name: its record names other bytes, so this key is ours
    // alone. Otherwise (no record yet, or the same bytes) the key may be about to be
    // recorded by a concurrent upload of the same bytes: it stays, and is removed with
    // the repository if nothing records it.
    const taken = await ctx.call({ op: 'repo_release_asset', tag, name }).catch(() => null);
    if (taken && taken.sha256 !== sha256) await ctx.env.OBJECTS.delete(key).catch(() => {});
    throw e;
  }
}

/** The recorded asset and its R2 object. */
async function readAsset(ctx: RepoContext, tag: unknown, name: unknown) {
  const asset = await ctx.call({ op: 'repo_release_asset', tag, name });
  const object = await ctx.env.OBJECTS.get(assetKey(ctx.repo, asset.tag, asset.sha256, asset.name));
  if (!object) throw new ApiError('NOT_FOUND', `Asset ${asset.name} is missing from storage`);
  return { asset, object };
}

const DOWNLOAD = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/releases\/([^/]+)\/assets\/([^/]+)$/;

/** `GET /api/v1/repos/:id/releases/:tag/assets/:name`: the asset's bytes (null for any
 * other request). */
export function releaseDownload(req: Request, env: Env, url: URL, auth: Credentials) {
  const match = DOWNLOAD.exec(url.pathname);
  if (!match || req.method !== 'GET') return null;
  const ctx = new RepoContext(env, match[1], caller(env, match[1], auth));
  return downloadAsset(ctx, decodeURIComponent(match[2]), decodeURIComponent(match[3]));
}

async function downloadAsset(ctx: RepoContext, tag: string, name: string) {
  const { asset, object } = await readAsset(ctx, tag, name);
  return new Response(object.body, {
    headers: {
      'content-type': asset.content_type,
      'content-length': String(asset.size),
      'content-disposition': `attachment; filename="${asset.name}"`,
      'x-yoneda-sha256': asset.sha256,
      'cache-control': 'no-store',
    },
  });
}

/** Operations shared by REST and MCP. */
export const releaseOperations = {
  git_release_create: (ctx: RepoContext, a: Json) =>
    notified(
      ctx,
      ctx.call({ op: 'repo_release_create', tag: a.tag, title: a.title, notes: a.notes ?? null }),
    ),
  git_release_list: (ctx: RepoContext, a: Json) =>
    ctx.call({ op: 'repo_releases', ...(a.limit === undefined ? {} : { limit: Number(a.limit) }) }),
  git_release_show: (ctx: RepoContext, a: Json) =>
    ctx.call({ op: 'repo_release_show', tag: a.tag }),
  // The authority forgets the release first; its asset bytes go after (a lost delete
  // leaves bytes nothing serves, removed with the repository).
  git_release_delete: async (ctx: RepoContext, a: Json) => {
    const deleted = await ctx.call({ op: 'repo_release_delete', tag: a.tag });
    const keys = (deleted.assets as Json[]).map((a) =>
      assetKey(ctx.repo, deleted.tag, a.sha256, a.name),
    );
    if (keys.length > 0) await ctx.env.OBJECTS.delete(keys).catch(() => {});
    await notifyHooks(ctx.env, ctx.repo);
    return deleted;
  },
  git_release_asset_upload: (ctx: RepoContext, a: Json) => {
    if (typeof a.content_b64 !== 'string')
      throw new ApiError('INVALID_INPUT', 'content_b64 must be the asset bytes in base64');
    const bytes = fromBase64(a.content_b64);
    if (bytes.length > MCP_ASSET_BYTES)
      throw new ApiError('TOO_LARGE', `Upload assets over ${MCP_ASSET_BYTES} bytes over REST`);
    return uploadAsset(ctx, a.tag, a.name, bytes, a.content_type);
  },
  git_release_asset_download: async (ctx: RepoContext, a: Json) => {
    const { asset, object } = await readAsset(ctx, a.tag, a.name);
    if (asset.size > MCP_ASSET_BYTES) {
      await object.body.cancel();
      throw new ApiError('TOO_LARGE', `Download assets over ${MCP_ASSET_BYTES} bytes over REST`);
    }
    return { ...asset, content_b64: toBase64(new Uint8Array(await object.arrayBuffer())) };
  },
};

/** `GET|POST /releases`, `GET|DELETE /releases/:tag`, `PUT /releases/:tag/assets/:name`
 * (the raw bytes as the body). Downloads are served before routing (`downloadAsset`). */
export async function releasesRoute(
  ctx: RepoContext,
  req: Request,
  path: string[],
  body: () => Promise<Json>,
): Promise<Json> {
  const ops = releaseOperations;
  const [tag, sub, name] = path.map(decodeURIComponent);
  const { method } = req;
  if (!tag && method === 'GET')
    return ops.git_release_list(ctx, Object.fromEntries(new URL(req.url).searchParams));
  if (!tag && method === 'POST') return ops.git_release_create(ctx, await body());
  if (tag && !sub && method === 'GET') return ops.git_release_show(ctx, { tag });
  if (tag && !sub && method === 'DELETE') return ops.git_release_delete(ctx, { tag });
  if (tag && sub === 'assets' && name && path.length === 3 && method === 'PUT') {
    if (!req.body) throw new ApiError('INVALID_INPUT', 'The asset bytes are the request body');
    const bytes = await bodyBytes(req.body);
    return uploadAsset(ctx, tag, name, bytes, req.headers.get('content-type'));
  }
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}
