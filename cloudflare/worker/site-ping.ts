// The ping (`POST /api/e`, front Worker): a browser that ran the page says so, which is what makes
// a Human view; a page request with no ping stays unconfirmed. It carries only the path and the
// referring site's name. It always answers an empty 204: it sets no cookie, keeps no IP address
// or user agent, and takes only same-origin requests about pages that exist. A forged ping or a
// scripted browser still counts: this keeps out scanners, not a determined script. A signed-in
// reader of a public page counts too: the point says only that a session was there, never whose,
// and the page is looked up without the cookie, so a private repository and the app never match.
import { normalizeHandle } from '../../shared/account';
import { appHead, siteHead } from './seo-head';
import {
  APP_PAGES,
  hasSession,
  isOwnTraffic,
  readSignupSource,
  referrerName,
  writeSitePoint,
} from './site-events';
import { sentByBrowser } from './traffic-class';
import type { Env } from './types';

const BODY_LIMIT = 1024;
// A path as a browser's location gives it. `//` would name another host to `new URL`.
const PATH = /^(?:\/[A-Za-z0-9._~%-]+)+\/?$|^\/$/;

export async function sitePing(req: Request, env: Env): Promise<Response> {
  try {
    await record(req, env);
  } catch {
    // A lost ping is one uncounted view; the visitor never hears about it.
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function record(req: Request, env: Env) {
  if (env.TRAFFIC_EVENTS !== 'on' || !env.SITE_EVENTS || req.method !== 'POST') return;
  const url = new URL(req.url);
  if (req.headers.get('origin') !== url.origin) return;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return;
  if (isOwnTraffic(req) || !sentByBrowser(req)) return;
  const address = req.headers.get('cf-connecting-ip') ?? 'local';
  if (env.AUTH_LIMITER && !(await env.AUTH_LIMITER.limit({ key: `ping:${address}` })).success)
    return;
  const text = await req.text();
  if (text.length > BODY_LIMIT) return;
  const body = JSON.parse(text) as { path?: unknown; referrer?: unknown };
  if (typeof body?.path !== 'string' || !PATH.test(body.path)) return;
  const path = await knownPage(body.path, url.origin, address, env);
  if (!path) return;
  write(req, env, path, referrerName(body.referrer, url.hostname));
}

function write(req: Request, env: Env, path: string, referrer: string) {
  writeSitePoint(env, 'ping', req, {
    path,
    referrer,
    source: readSignupSource(null),
    class: hasSession(req) ? 'signed_in' : 'human',
    automated: false,
  });
}

/** The page's own address, or null: a site route, Explore, a public repository (from any page
 * inside it) or a profile. Unlike a page request, a ping may ask the platform: it is rate limited
 * and nobody waits for it. */
async function knownPage(path: string, origin: string, address: string, env: Env) {
  const app = APP_PAGES.get(path);
  if (app) return app;
  const headers = { 'cf-connecting-ip': address };
  const site = await siteHead(new Request(`${origin}${path}`), env);
  if (site) return site.canonical ?? null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1) return (await isProfile(parts[0], origin, headers, env)) ? path : null;
  const page = new Request(`${origin}/${parts.slice(0, 2).join('/')}`, { headers });
  return (await appHead(page, env)).canonical ?? null;
}

async function isProfile(
  handle: string,
  origin: string,
  headers: Record<string, string>,
  env: Env,
) {
  if (!env.PLATFORM || !normalizeHandle(handle)) return false;
  const asked = new Request(`${origin}/api/v1/profiles/${handle}`, { headers });
  return (await env.PLATFORM.fetch(asked)).ok;
}
