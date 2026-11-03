import { expect, it } from 'vitest';
import { websitePage } from '../../cloudflare/worker/website-metadata';
import type { Env } from '../../cloudflare/worker/types';

function env(type = 'text/javascript', status = 200, cache = 'public, max-age=0, must-revalidate', flag = 'on') {
  return { STATIC_ASSET_CACHE: flag, ASSETS: { fetch: async (req: Request) =>
    new URL(req.url).pathname === '/_site/routes.json'
      ? new Response(null, {status:404})
      : new Response(status === 304 ? null : 'build bytes', {status,headers:{'content-type':type,'cache-control':cache,etag:'"build-hash"'}}),
  } } as unknown as Env;
}
const get = async (path: string, bindings = env()) => (await websitePage(new Request(`https://yoneda${path}`), bindings)).response;
it('caches successful fingerprinted public build assets without revalidation', async () => {
  for(const [name,type] of [['index-Ab12_Cd3.js','text/javascript'],['index-Ab12_Cd3.css','text/css'],['logo-Ab12_Cd3.webp','image/webp'],['font-Ab12_Cd3.woff2','font/woff2']]){
    const result=await get(`/assets/${name}`,env(type));
    expect(result.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(result.headers.get('etag')).toBe('"build-hash"');
    expect(await result.text()).toBe('build bytes');
  }
});
it('keeps errors, private responses, HTML fallbacks and non-fingerprinted content fresh', async () => {
  for(const [path,on] of [
    ['/assets/index.js',env()],['/api/v1/repos/r00000000000000000001',env()],
    ['/assets/index-Ab12_Cd3.js',env('text/javascript',404)],
    ['/assets/index-Ab12_Cd3.js',env('text/html')],
    ['/assets/index-Ab12_Cd3.js',env('text/javascript',200,'private, no-store')],
    ['/assets/index-Ab12_Cd3.js',env('text/javascript',200,undefined,'off')],
  ] as const){expect((await get(path,on)).headers.get('cache-control')).not.toContain('immutable');}
});
