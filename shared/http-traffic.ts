/** Telemetry classes only: never an access decision or a reason to block a route. */
export const HTTP_TRAFFIC = [
  'page',
  'api',
  'health',
  'scanner',
  'asset',
  'transfer',
  'own',
] as const;
export type HttpTraffic = (typeof HTTP_TRAFFIC)[number];

export function httpTraffic(url: string, own = false): HttpTraffic {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/health') return 'health';
  // Known probe-shaped paths, not all filenames or arbitrary repository names ending in .php.
  if (
    /(^|\/)\.env(?:\.[^/]*)?$/.test(path) ||
    /(^|\/)(?:phpinfo(?:\.php)?|php_info\.php|php_version\.php|phpversion\.php|pinfo\.php)$/.test(
      path,
    ) ||
    /^\/(?:wp-admin|wp-login\.php|cgi-bin)(?:\/|$)/.test(path)
  )
    return 'scanner';
  if (own) return 'own';
  if (
    /^\/(?:assets|brand|fonts)\//.test(path) ||
    /\.(?:css|js|woff2?|ico|png|svg|jpe?g|webp)$/.test(path)
  )
    return 'asset';
  if (
    path.startsWith('/downloads/') ||
    /\/(?:git-upload-pack|git-receive-pack|info\/refs)$/.test(path)
  )
    return 'transfer';
  if (path.startsWith('/api/') || path.startsWith('/auth/')) return 'api';
  return 'page';
}
