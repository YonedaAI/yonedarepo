import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { serveSite, type SitesEnv } from '../../cloudflare/sites';
import { authorizePreview, previewLink } from '../../cloudflare/worker/sites';
import { ledger, object } from '../../cloudflare/worker/storage';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import type { Env } from '../../cloudflare/worker/types';
const bindings = env as unknown as Env;
afterEach(reset);
it('isolates untrusted site assets, binds preview capabilities and preserves publication pointers', async () => {
 await ledger(bindings,'alice-site',{op:'init',id:'alice-site',name:'Alice site',remote:{namespace:'yoneda-test',name:'alice-site'},commit:'a'.repeat(40),policy:sitePolicy});
 const manifest = {repo:'alice-site', revision:{commit:'a'.repeat(40)},files:{'index.html':{content:'<html>Published</html>'},'logo.png':{content:'/wCA',encoding:'base64'}}};
 const stored=await object(bindings,JSON.stringify(manifest));
 const local={...bindings,SITE_ORIGIN:'https://sites.example'};
 const link=await previewLink(local,'alice-site',{deployment:stored});
 const siteEnv={OBJECTS:bindings.OBJECTS,PLATFORM:{authorizePreview:(digest:string,token:string)=>authorizePreview(local,digest,token),siteManifest:async()=>({...stored,commit:'a'.repeat(40)})}} as unknown as SitesEnv;
 const page=await serveSite(new Request(link.url,{headers:{cookie:'yoneda_account=private'}}),siteEnv);
 expect(page.status).toBe(200);expect(await page.text()).toContain('Published');expect(page.headers.get('content-security-policy')).toContain('sandbox allow-scripts');expect(page.headers.has('set-cookie')).toBe(false);expect(page.headers.get('referrer-policy')).toBe('no-referrer');
 const binary=await serveSite(new Request(`${link.url}logo.png`),siteEnv);expect([...new Uint8Array(await binary.arrayBuffer())]).toEqual([255,0,128]);
 expect((await serveSite(new Request(link.url.replace(stored.digest,'b'.repeat(64))),siteEnv)).status).toBe(404);
 expect((await serveSite(new Request(link.url.replace(/\/$/,'/missing.txt')),siteEnv)).status).toBe(404);
 const published=await serveSite(new Request('https://sites.example/p/alice-site/'),siteEnv);expect(published.status).toBe(200);expect(published.headers.get('cache-control')).toContain('no-store');
 await bindings.OBJECTS.put(`sha256/${stored.digest}`,'corrupted'); expect((await serveSite(new Request('https://sites.example/p/alice-site/'),siteEnv)).status).toBe(503);
});

it('serves root-relative asset references from the preview or published path that hosts the site', async () => {
 await ledger(bindings,'bob-site',{op:'init',id:'bob-site',name:'Bob site',remote:{namespace:'yoneda-test',name:'bob-site'},commit:'b'.repeat(40),policy:sitePolicy});
 const files={
  'index.html':{content:'<link rel="stylesheet" href="/style.css"><a href="//cdn.example/x">x</a><script type="module" src="/app.mjs"></script><img src=\'/logo.png\'>'},
  'app.mjs':{content:"import { addTask } from '/tasks.mjs';\nimport '/side.mjs';\nconst lazy = () => import(\"/lazy.mjs\");\nconst url = 'https://example.com/keep';"},
  'style.css':{content:"body { background: url(/bg.png); } .x { background: url('//cdn.example/y.png'); }"},
 };
 const stored=await object(bindings,JSON.stringify({repo:'bob-site',revision:{commit:'b'.repeat(40)},files}));
 const local={...bindings,SITE_ORIGIN:'https://sites.example'};
 const link=await previewLink(local,'bob-site',{deployment:stored});
 const siteEnv={OBJECTS:bindings.OBJECTS,PLATFORM:{authorizePreview:(digest:string,token:string)=>authorizePreview(local,digest,token),siteManifest:async()=>({...stored,commit:'b'.repeat(40)})}} as unknown as SitesEnv;
 const prefix=new URL(link.url).pathname;
 const html=await (await serveSite(new Request(link.url),siteEnv)).text();
 expect(html).toContain(`href="${prefix}style.css"`);expect(html).toContain(`src="${prefix}app.mjs"`);expect(html).toContain(`src='${prefix}logo.png'`);expect(html).toContain('href="//cdn.example/x"');
 const js=await (await serveSite(new Request(`${link.url}app.mjs`),siteEnv)).text();
 expect(js).toContain(`from '${prefix}tasks.mjs'`);expect(js).toContain(`import '${prefix}side.mjs'`);expect(js).toContain(`import("${prefix}lazy.mjs")`);expect(js).toContain("'https://example.com/keep'");
 const css=await (await serveSite(new Request(`${link.url}style.css`),siteEnv)).text();
 expect(css).toContain(`url(${prefix}bg.png)`);expect(css).toContain("url('//cdn.example/y.png')");
 const published=await (await serveSite(new Request('https://sites.example/p/bob-site/'),siteEnv)).text();
 expect(published).toContain('href="/p/bob-site/style.css"');
});
