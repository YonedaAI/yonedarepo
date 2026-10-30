// The Cloudflare Web Analytics beacon (front Worker): a cookieless script added to the head of
// public site pages when WEB_ANALYTICS_TOKEN holds a site token. Kept apart from the page
// metadata rewriter (website-metadata.ts) so either changes without the other.
import { isPublicPage } from './site-events';
import type { Env } from './types';

const BEACON = 'https://static.cloudflareinsights.com/beacon.min.js';
// Web Analytics site tokens are 32 hex characters; anything else is a misconfiguration and,
// being written into HTML, is refused rather than escaped.
const TOKEN = /^[a-f0-9]{32}$/i;

/** The page with the beacon appended to its head, or unchanged. */
export function withWebAnalytics(req: Request, res: Response, env: Env): Response {
  const token = env.WEB_ANALYTICS_TOKEN?.trim() ?? '';
  if (!TOKEN.test(token) || !isPublicPage(req, res)) return res;
  const script = `<script defer src="${BEACON}" data-cf-beacon='{"token":"${token}"}'></script>`;
  return new HTMLRewriter()
    .on('head', {
      element(head) {
        head.append(script, { html: true });
      },
    })
    .transform(res);
}
