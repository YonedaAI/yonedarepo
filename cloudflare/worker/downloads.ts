// The site's public downloads: /install.sh (frontend/public/install.sh, with this site's
// origin filled in) and /downloads/<key> from the DOWNLOADS bucket, which
// `cargo xtask downloads` stages and uploads:
//   cli/LATEST                         the latest release's version, one line
//   cli/latest.json                    the same as a manifest: each target's archive, size, sha256
//   cli/<version>/SHA256SUMS           sha256sum lines for the release's archives
//   cli/<version>/yoneda-<version>-<target>.tar.gz   yoneda and git-remote-yoneda
//   claude/marketplace.json            the public Claude Code marketplace (no Git host needed)
//   claude/yoneda-<version>.zip        the plugin it lists, pinned there by sha256
// Only these two prefixes are served; LATEST and the two JSON files change between
// releases, everything else is written once.
import type { Env } from './types';

const KEY = /^(cli|claude)\/[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+)?$/;
const CHANGING = new Set(['cli/LATEST', 'cli/latest.json', 'claude/marketplace.json']);

/** The bucket key a /downloads path names, or undefined for anything outside the layout. */
export function downloadKey(pathname: string): string | undefined {
  const key = pathname.slice('/downloads/'.length);
  if (!pathname.startsWith('/downloads/') || !KEY.test(key)) return undefined;
  return key.split('/').some((part) => part === '.' || part === '..') ? undefined : key;
}

export function contentType(key: string): string {
  if (key.endsWith('.tar.gz')) return 'application/gzip';
  if (key.endsWith('.zip')) return 'application/zip';
  if (key.endsWith('.json')) return 'application/json';
  return 'text/plain; charset=utf-8';
}

export function cacheControl(key: string): string {
  return CHANGING.has(key) ? 'public, max-age=300' : 'public, max-age=31536000, immutable';
}

const notFound = (message: string) =>
  new Response(message, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** GET or HEAD of /downloads/<key>. */
export async function serveDownload(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const key = downloadKey(new URL(req.url).pathname);
  if (!key) return notFound('No such download');
  if (!env.DOWNLOADS) return notFound('Downloads are not published on this site');
  const object = await env.DOWNLOADS.get(key);
  if (!object) return notFound('No such download');
  const headers = new Headers({
    'content-type': contentType(key),
    'cache-control': cacheControl(key),
    'content-length': String(object.size),
    etag: object.httpEtag,
    'x-content-type-options': 'nosniff',
  });
  return new Response(req.method === 'HEAD' ? null : object.body, { headers });
}

/** /install.sh: the installer with this site (`origin`) as its download base. */
export async function serveInstallScript(
  req: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL('/install.sh', req.url));
  if (!origin || !asset.ok) return notFound('The installer is not published on this site');
  const script = (await asset.text()).replace('__YONEDA_SITE__', origin);
  return new Response(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
