// Only public fingerprinted build output is immutable; application data stays fresh.
import type { Env } from './types';

const FINGERPRINTED =
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|webp|avif|gif|svg)$/;
const TYPES: Record<string, RegExp> = {
  js: /^(text|application)\/(javascript|ecmascript)(;|$)/,
  css: /^text\/css(;|$)/,
  woff: /^(font\/woff|application\/font-woff)(;|$)/,
  woff2: /^(font\/woff2|application\/font-woff2)(;|$)/,
  png: /^image\/png(;|$)/,
  jpg: /^image\/jpeg(;|$)/,
  jpeg: /^image\/jpeg(;|$)/,
  webp: /^image\/webp(;|$)/,
  avif: /^image\/avif(;|$)/,
  gif: /^image\/gif(;|$)/,
  svg: /^image\/svg\+xml(;|$)/,
};

export function staticAssetCache(
  req: Request,
  env: Env,
  result: Response,
  type = result.headers.get('content-type'),
): Response {
  const extension = FINGERPRINTED.exec(new URL(req.url).pathname)?.[1];
  if (
    env.STATIC_ASSET_CACHE !== 'on' ||
    !['GET', 'HEAD'].includes(req.method) ||
    !extension ||
    ![200, 304].includes(result.status) ||
    !type ||
    !TYPES[extension]?.test(type) ||
    result.headers.has('set-cookie') ||
    /\b(private|no-store)\b/.test(result.headers.get('cache-control') ?? '')
  )
    return result;
  const headers = new Headers(result.headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}
