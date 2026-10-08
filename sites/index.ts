//! Untrusted static output has a separate Worker origin and an opaque sandbox origin.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { readObject } from '../worker/storage';
import type { YonedaEntrypoint } from '../worker/entrypoint';
export interface SitesEnv { OBJECTS: R2Bucket; PLATFORM: Service<YonedaEntrypoint> }
export default class SitesEntrypoint extends WorkerEntrypoint<SitesEnv> {
  async fetch(req: Request) { return serveSite(req, this.env); }
}
const mime: Record<string,string> = { html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',txt:'text/plain; charset=utf-8',pdf:'application/pdf' };
const missing = () => new Response('Site not found', { status: 404,headers:{'cache-control':'no-store'} });
export async function serveSite(req: Request, env: SitesEnv): Promise<Response> {
  if (!['GET','HEAD'].includes(req.method)) return new Response('Read only',{status:405});
  try {
    const url=new URL(req.url); const parts=url.pathname.split('/').filter(Boolean); let digest: string; let path: string;
    if (parts[0]==='v' && /^[a-f0-9]{64}$/.test(parts[1]??'') && parts[2]) {
      if (!await env.PLATFORM.authorizePreview(parts[1],parts[2])) return missing();
      digest=parts[1];path=parts.slice(3).join('/');
    } else if (parts[0]==='p' && /^[a-zA-Z0-9-]{1,120}$/.test(parts[1]??'')) {
      const site=await env.PLATFORM.siteManifest(parts[1]); if (!site?.digest) return missing(); digest=site.digest;path=parts.slice(2).join('/');
    } else return missing();
    if (!path && !url.pathname.endsWith('/')) { url.pathname+='/';return Response.redirect(url.href,307); }
    path=decodeURIComponent(path || 'index.html');
    if (path.includes('\\') || path.split('/').some((p)=>p==='..'||p==='.'||!p)) return missing();
    const manifest=JSON.parse(await readObject(env,digest)); const file=manifest.files?.[path]; if (!file) return missing();
    const body=file.encoding==='base64'? Uint8Array.from(atob(file.content),(c)=>c.charCodeAt(0)):new TextEncoder().encode(file.content);
    return new Response(req.method==='HEAD'?null:body,{headers:{
      'content-type':mime[path.split('.').at(-1) ?? ''] ?? 'application/octet-stream',
      'cache-control':parts[0]==='v'?'private, max-age=300':'no-store',
      'content-security-policy':"sandbox allow-scripts allow-forms; default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; worker-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
      'x-content-type-options':'nosniff','referrer-policy':'no-referrer','access-control-allow-origin':'*',
      'permissions-policy':'camera=(), microphone=(), geolocation=()',
    }});
  } catch { return new Response('Site assets are temporarily unavailable',{status:503,headers:{'cache-control':'no-store'}}); }
}
