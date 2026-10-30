import { appHead, indexable, type PageHead, siteHead, structuredData } from './seo-head';
import type { Env } from './types';

/** Meta tags whose content is the page's title or description. */
const TITLED = ['og:title', 'twitter:title'];
const DESCRIBED = ['description', 'og:description', 'twitter:description'];

/** Resolve public metadata before scripts run; private account data never enters the head. A
 * site page is served from its prerendered copy with its own head (seo-head.ts). */
export async function websiteAssets(req: Request, env: Env): Promise<Response> {
  // The prerendered copies are served at their pages' own addresses only.
  if (new URL(req.url).pathname.startsWith('/_site/'))
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const site = await siteHead(req, env);
  const asked = site?.asset ? new Request(new URL(site.asset, req.url), req) : req;
  let assets = await env.ASSETS.fetch(asked);
  if (assets.status === 304) {
    // A pre-upgrade static validator can refer to HTML that still contains the template tokens.
    const headers = new Headers(asked.headers);
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    const complete = await env.ASSETS.fetch(new Request(asked, { headers }));
    if (!complete.headers.get('content-type')?.includes('text/html')) return assets;
    assets = complete;
  }
  if (!assets.headers.get('content-type')?.includes('text/html')) return assets;
  const origin = publicOrigin(req, env.PUBLIC_APP_ORIGIN);
  if (!origin)
    return new Response('Invalid public application origin', {
      status: 500,
      headers: { 'cache-control': 'no-store' },
    });
  const head: PageHead = site ?? (await appHead(req, env));
  // HTMLRewriter escapes quotes; escape ampersands so hostname text cannot become an entity.
  const attr = (text: string) => text.replaceAll('&', '&amp;');
  const canonical = head.canonical === undefined ? undefined : attr(`${origin}${head.canonical}`);
  const publicUrl = canonical ?? attr(`${origin}/`);
  const image = attr(`${origin}/brand/social-card.png`);
  const noindex = head.noindex || !indexable(env);
  // `<` cannot close the script early; JSON needs no other escaping inside it.
  const jsonLd = structuredData(head.route, origin)
    .map(
      (data) =>
        `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('');
  const headers = new Headers(assets.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  if (!indexable(env)) headers.set('x-robots-tag', 'noindex');
  const html = new Response(assets.body, {
    status: assets.status,
    statusText: assets.statusText,
    headers,
  });
  return new HTMLRewriter()
    .on('title', {
      element(element) {
        if (head.title) element.setInnerContent(head.title);
      },
    })
    .on('meta', {
      element(element) {
        const content = element.getAttribute('content');
        if (content === '__YONEDA_PUBLIC_ORIGIN__') element.setAttribute('content', publicUrl);
        if (content === '__YONEDA_SOCIAL_IMAGE_URL__') element.setAttribute('content', image);
        const key = element.getAttribute('property') ?? element.getAttribute('name') ?? '';
        if (head.title && TITLED.includes(key)) element.setAttribute('content', attr(head.title));
        if (head.description && DESCRIBED.includes(key))
          element.setAttribute('content', attr(head.description));
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        if (canonical) element.setAttribute('href', canonical);
        else element.remove();
      },
    })
    .on('head', {
      element(element) {
        if (noindex) element.append('<meta name="robots" content="noindex">', { html: true });
        if (jsonLd) element.append(jsonLd, { html: true });
      },
    })
    .transform(html);
}

export function publicOrigin(req: Request, configured?: string): string | null {
  try {
    const url = new URL(configured || new URL(req.url).origin);
    const localHttp =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !localHttp)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
