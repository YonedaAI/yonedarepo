import type { Env } from './types';

/** Resolve public metadata before scripts run; private account data never enters the head. */
export async function websiteAssets(req: Request, env: Env): Promise<Response> {
  let assets = await env.ASSETS.fetch(req);
  if (assets.status === 304) {
    // A pre-upgrade static validator can refer to HTML that still contains the template tokens.
    const headers = new Headers(req.headers);
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    const complete = await env.ASSETS.fetch(new Request(req, { headers }));
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
  // HTMLRewriter escapes quotes; escape ampersands so hostname text cannot become an entity.
  const publicUrl = `${origin}/`.replaceAll('&', '&amp;');
  const image = `${origin}/brand/social-card.png`.replaceAll('&', '&amp;');
  const headers = new Headers(assets.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  const html = new Response(assets.body, {
    status: assets.status,
    statusText: assets.statusText,
    headers,
  });
  return new HTMLRewriter()
    .on('meta', {
      element(element) {
        const content = element.getAttribute('content');
        if (content === '__YONEDA_PUBLIC_ORIGIN__') element.setAttribute('content', publicUrl);
        if (content === '__YONEDA_SOCIAL_IMAGE_URL__') element.setAttribute('content', image);
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        element.setAttribute('href', publicUrl);
      },
    })
    .transform(html);
}

function publicOrigin(req: Request, configured?: string): string | null {
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
