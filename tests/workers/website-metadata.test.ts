import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { websitePage } from '../../cloudflare/worker/website-metadata';

const websiteAssets = async (req: Request, env: Env) => (await websitePage(req, env)).response;

const template = `<!doctype html><html><head>
<title>YonedaRepo — The Git platform built for agents</title>
<meta name="description" content="Host, review and land code with agents on a Git platform that gives every change a Flight Path, built for the scale and throughput of agentic coding. Every session’s context stays with the code.">
<link rel="canonical" href="__YONEDA_PUBLIC_ORIGIN__">
<meta property="og:url" content="__YONEDA_PUBLIC_ORIGIN__">
<meta property="og:image" content="__YONEDA_SOCIAL_IMAGE_URL__">
<meta name="twitter:image" content="__YONEDA_SOCIAL_IMAGE_URL__">
</head><body><div id="root"></div></body></html>`;

function bindings(origin?: string, asset?: () => Response) {
  return {
    PUBLIC_APP_ORIGIN: origin,
    ASSETS: {
      fetch: async () =>
        asset?.() ??
        new Response(template, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            etag: 'same-static-etag',
            'last-modified': 'Thu, 08 Oct 2026 12:00:00 GMT',
            'cache-control': 'public, max-age=3600',
            'content-length': String(template.length),
            'x-static-header': 'preserved',
          },
        }),
    },
  } as unknown as Env;
}

async function headAttributes(html: string) {
  const values: Record<string, string | null> = {};
  await new HTMLRewriter()
    .on('meta', {
      element(element) {
        const key = element.getAttribute('property') ?? element.getAttribute('name');
        if (key) values[key] = attribute(element.getAttribute('content'));
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        values.canonical = attribute(element.getAttribute('href'));
      },
    })
    .transform(new Response(html))
    .text();
  return values;
}

// HTMLRewriter exposes serialized attribute entities; decode one HTML layer for assertions.
function attribute(value: string | null) {
  return value?.replaceAll('&quot;', '"').replaceAll('&amp;', '&') ?? null;
}

it('rewrites public metadata before JavaScript using the request origin without private request details', async () => {
  const request = new Request(
    'https://preview.example/workspace/private-project?token=private-token',
    {
      headers: { cookie: 'session=private-cookie', authorization: 'Bearer private-credential' },
    },
  );
  const response = await websiteAssets(request, bindings());
  const html = await response.text();
  const head = await headAttributes(html);
  expect(head).toMatchObject({
    'og:url': 'https://preview.example/',
    'og:image': 'https://preview.example/brand/social-card.png',
    'twitter:image': 'https://preview.example/brand/social-card.png',
    robots: 'noindex',
  });
  // A repository page nobody signed out may read claims no address of its own.
  expect(head.canonical).toBeUndefined();
  expect(html).not.toContain('__YONEDA_');
  for (const privateValue of [
    'private-project',
    'private-token',
    'private-cookie',
    'private-credential',
  ])
    expect(html).not.toContain(privateValue);
  expect(response.headers.get('etag')).toBeNull();
  expect(response.headers.get('last-modified')).toBeNull();
  expect(response.headers.get('content-length')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-static-header')).toBe('preserved');
});

it('uses an explicitly configured public origin and escapes HTML attribute metacharacters', async () => {
  const origin = 'https://preview"&.example';
  const response = await websiteAssets(new Request('https://alternate.example/'), bindings(origin));
  const html = await response.text();
  expect(await headAttributes(html)).toMatchObject({
    canonical: `${origin}/`,
    'og:url': `${origin}/`,
    'og:image': `${origin}/brand/social-card.png`,
  });
  expect(html).not.toContain(`content="${origin}`);
  expect(html).toContain('preview&quot;&amp;.example');
  expect(html).not.toContain('__YONEDA_');
});

it('leaves public non-HTML assets untouched, including their caching headers', async () => {
  const image = new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      etag: 'image-etag',
      'cache-control': 'public, max-age=3600',
    },
  });
  const response = await websiteAssets(
    new Request('https://preview.example/brand/social-card.png'),
    bindings('invalid', () => image),
  );
  expect(response).toBe(image);
  expect(response.headers.get('etag')).toBe('image-etag');
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71]);
});

it('rejects malformed, credentialed or non-origin configuration with a safe controlled response', async () => {
  for (const origin of [
    'not-a-url',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?token=secret',
    'http://public.example',
    'javascript:alert(1)',
  ]) {
    const response = await websiteAssets(new Request('https://preview.example/'), bindings(origin));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Invalid public application origin');
  }
  const local = await websiteAssets(new Request('http://localhost:8787/'), bindings());
  expect(local.status).toBe(200);
  expect((await headAttributes(await local.text())).canonical).toBe('http://localhost:8787/');
});

it('recovers HTML from a stale static ETag without serving an unrewritten 304', async () => {
  const requests: Request[] = [];
  const env = bindings();
  env.ASSETS = {
    fetch: async (request: Request) => {
      requests.push(request);
      return request.headers.has('if-none-match')
        ? new Response(null, { status: 304, headers: { etag: 'same-static-etag' } })
        : new Response(template, { headers: { 'content-type': 'text/html' } });
    },
  } as unknown as Fetcher;
  const response = await websiteAssets(
    new Request('https://preview.example/', { headers: { 'if-none-match': 'same-static-etag' } }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain('__YONEDA_');
  // Besides the build's route manifest (seo-head.ts), asked once.
  const pages = requests.filter((r) => !r.url.endsWith('/_site/routes.json'));
  expect(pages).toHaveLength(2);
  expect(pages[1].headers.has('if-none-match')).toBe(false);
});

it('preserves a non-HTML conditional response while discarding validators only for its probe', async () => {
  const cached = new Response(null, { status: 304, headers: { etag: 'image-etag' } });
  const env = bindings();
  env.ASSETS = {
    fetch: async (request: Request) =>
      request.headers.has('if-modified-since')
        ? cached
        : new Response('svg source', { headers: { 'content-type': 'image/svg+xml' } }),
  } as unknown as Fetcher;
  const response = await websiteAssets(
    new Request('https://preview.example/favicon.svg', {
      headers: { 'if-modified-since': 'Thu, 08 Oct 2026 12:00:00 GMT' },
    }),
    env,
  );
  expect(response).toBe(cached);
  expect(response.status).toBe(304);
  expect(response.headers.get('etag')).toBe('image-etag');
});

it('serves a generic signed-in app head without waiting for optional repository metadata', async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  let lookups = 0;
  const env = { ...bindings(), SEO_INDEXING: 'on', FAST_APP_HEAD: 'on', PLATFORM: {
    fetch: () => { lookups++; return held; },
  } } as unknown as Env;
  const request = new Request('https://preview.example/owner/secret-project', {
    headers: { cookie: 'yoneda_account=only-a-hint' },
  });
  const page = websiteAssets(request, env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([page, new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('waiting for optional metadata'), 500);
    })]);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    const html = await response.text();
    expect(await headAttributes(html)).toMatchObject({ robots: 'noindex' });
    expect(html).not.toContain('secret-project');
    expect(lookups).toBe(0);
    expect(response.headers.get('cache-control')).toBe('no-store');
  } finally {
    clearTimeout(timer);
    release(new Response(null, { status: 404 }));
    await page;
  }
});

it('keeps public repository metadata for anonymous requests and when the switch is off', async () => {
  for (const [flag, cookie] of [['on', ''], ['off', 'yoneda_account=hint'], ['on', 'other_yoneda_account=hint'], ['on', 'yoneda_account=']]) {
    let lookups = 0;
    const env = { ...bindings(), SEO_INDEXING: 'on', FAST_APP_HEAD: flag, PLATFORM: {
      fetch: async () => { lookups++; return Response.json({ handle: 'owner', name: 'public-project', path: '/owner/public-project' }); },
    } } as unknown as Env;
    const response = await websiteAssets(new Request('https://preview.example/owner/public-project', { headers: { cookie } }), env);
    const head = await headAttributes(await response.text());
    expect(lookups).toBe(1);
    expect(head.canonical).toBe('https://preview.example/owner/public-project');
    expect(head.robots).toBeUndefined();
  }
});

it('an unfinished manifest read cannot hold a later page request in the isolate', async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  let lookups = 0;
  const env = { ...bindings(), ASSETS: { fetch: (req: Request) => {
    if (new URL(req.url).pathname === '/_site/routes.json') {
      lookups++;
      return lookups === 1 ? held : Promise.resolve(Response.json({ routes: [], aliases: {} }));
    }
    return Promise.resolve(new Response(template, { headers: { 'content-type': 'text/html' } }));
  } } } as unknown as Env;
  const first = websiteAssets(new Request('https://preview.example/repositories'), env);
  const second = websiteAssets(new Request('https://preview.example/settings'), env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([second, new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('held by earlier page request'), 500);
    })]);
    expect(result).toBeInstanceOf(Response);
    expect(lookups).toBe(2);
  } finally {
    clearTimeout(timer);
    release(Response.json({ routes: [], aliases: {} }));
    await Promise.all([first, second]);
  }
});
