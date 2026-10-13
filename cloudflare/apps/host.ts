import { sha, validateDescriptor } from './bundle';
import type { AppPlatform, TrustedApp } from './contracts';
import { appRequest, appResponse, missing, redirect } from './http';
import type { AppRunner } from './runner';
export interface AppsEnv {
  APP_DOMAIN: string;
  APP_ORIGIN: string;
  PLATFORM_ORIGIN: string;
  PLATFORM: AppPlatform;
  APP_RUNNERS: DurableObjectNamespace<AppRunner>;
}
const COOKIE = '__Host-yoneda-app-preview';
const safeId = /^[a-zA-Z0-9_.-]{1,100}$/;
const dnsRepoId = /^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/;
function previewId(value: string) {
  const separator = value.indexOf(':');
  return (
    value.length <= 400 &&
    separator > 0 &&
    safeId.test(value.slice(0, separator)) &&
    /^[a-zA-Z0-9_.:-]{1,299}$/.test(value.slice(separator + 1))
  );
}
export async function previewOrigin(id: string, domain: string) {
  return `https://preview-${(await sha(id)).slice(0, 24)}.${domain}`;
}
function capability(request: Request): [string, string] | null {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return null;
  const value = JSON.parse(atob(cookies[0].slice(COOKIE.length + 1)));
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')
    ? (value as [string, string])
    : null;
}
async function authorize(env: AppsEnv, id: string, token: string): Promise<TrustedApp | null> {
  if (!previewId(id) || !token || token.length > 2048) return null;
  const app = await env.PLATFORM.authorizeAppPreview(id, token);
  if (app?.mode !== 'preview' || app.app_id !== id.split(':')[0]) return null;
  validateDescriptor(app);
  return app;
}
/** Shared gateway only redirects; all executable content gets a distinct host origin. */
export async function serveApp(request: Request, env: AppsEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const platform = new URL(env.PLATFORM_ORIGIN);
    const gateway = new URL(env.APP_ORIGIN);
    if (
      !/^[a-z0-9.-]+$/.test(env.APP_DOMAIN) ||
      platform.protocol !== 'https:' ||
      gateway.protocol !== 'https:' ||
      url.protocol !== 'https:' ||
      url.origin === platform.origin ||
      url.port ||
      !url.hostname.endsWith(`.${env.APP_DOMAIN}`)
    )
      return missing();
    const parts = url.pathname.split('/');
    if (parts.at(-1) === '') parts.pop();
    if (parts[1] === 'v' && parts.length === 4) {
      if (request.method !== 'GET') return missing();
      const id = decodeURIComponent(parts[2]);
      const token = decodeURIComponent(parts[3]);
      const app = await authorize(env, id, token);
      if (!app) return missing();
      const origin = await previewOrigin(id, env.APP_DOMAIN);
      if (url.origin === gateway.origin)
        return redirect(`${origin}/v/${encodeURIComponent(id)}/${encodeURIComponent(token)}`);
      if (url.origin !== origin) return missing();
      const cookie = `${COOKIE}=${btoa(JSON.stringify([id, token]))}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`;
      return redirect(`${origin}/`, cookie);
    }
    if (
      parts[1] === 'p' &&
      parts.length === 3 &&
      url.origin === gateway.origin &&
      request.method === 'GET'
    ) {
      const id = decodeURIComponent(parts[2]);
      if (!dnsRepoId.test(id)) return missing();
      const app = await env.PLATFORM.publishedApp(id);
      if (!app || app.app_id !== id || app.mode !== 'published') return missing();
      validateDescriptor(app);
      return redirect(`https://app-${id}.${env.APP_DOMAIN}/`);
    }
    let app: TrustedApp | null = null;
    let runnerId = '';
    if (url.hostname.startsWith('preview-')) {
      const cap = capability(request);
      if (!cap) return missing();
      if (url.origin !== (await previewOrigin(cap[0], env.APP_DOMAIN))) return missing();
      app = await authorize(env, cap[0], cap[1]);
      runnerId = `preview:${cap[0]}`;
    } else if (url.hostname.startsWith('app-')) {
      const id = url.hostname.slice(4, -env.APP_DOMAIN.length - 1);
      if (!dnsRepoId.test(id)) return missing();
      app = await env.PLATFORM.publishedApp(id);
      if (app?.mode !== 'published' || app.app_id !== id) return missing();
      runnerId = `published:${id}`;
    }
    if (!app) return missing();
    validateDescriptor(app);
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== url.origin)
      return new Response('Origin denied', {
        status: 403,
        headers: { 'cache-control': 'no-store' },
      });
    const runner = env.APP_RUNNERS.getByName(runnerId);
    return await appResponse(
      await runner.serve(app, await appRequest(request)),
      request,
      platform.origin,
    );
  } catch {
    return new Response('Application temporarily unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }
}
