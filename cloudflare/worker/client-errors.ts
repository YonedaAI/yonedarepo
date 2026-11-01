// `POST /api/client-error` (front Worker): a page that broke says what broke. It carries a message
// and a route, never page content, and the route is reduced here so a repository's name or a file
// path never reaches a log. Built like the ping (site-ping.ts): same-origin only, rate limited,
// always an empty 204, and nothing a browser sends can fail or slow anything else.
import { isReservedHandle } from '../../shared/account';
import { log } from './log';
import { sentByBrowser } from './traffic-class';
import type { Env } from './types';

const BODY_LIMIT = 2 * 1024;
const MESSAGE_LIMIT = 300;
// A path as a browser's location gives it.
const PATH = /^(?:\/[A-Za-z0-9._~%-]+)+\/?$|^\/$/;
const WORD = /^[a-z][a-z-]{0,31}$/;

export async function clientError(req: Request, env: Env): Promise<Response> {
  try {
    await record(req, env);
  } catch {
    // A report that cannot be read or kept is one error unseen; the page has troubles enough.
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function record(req: Request, env: Env) {
  if (env.CLIENT_ERRORS !== 'on' || req.method !== 'POST') return;
  if (req.headers.get('origin') !== new URL(req.url).origin) return;
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return;
  if (!sentByBrowser(req)) return;
  const address = req.headers.get('cf-connecting-ip') ?? 'local';
  if (
    env.AUTH_LIMITER &&
    !(await env.AUTH_LIMITER.limit({ key: `client-error:${address}` })).success
  )
    return;
  const text = await req.text();
  if (text.length > BODY_LIMIT) return;
  const body = JSON.parse(text) as { message?: unknown; route?: unknown };
  if (typeof body?.message !== 'string' || !body.message) return;
  if (typeof body.route !== 'string' || !PATH.test(body.route)) return;
  log.error('client.error', {
    message: body.message.slice(0, MESSAGE_LIMIT),
    route: routeOf(body.route),
  });
}

/** The page's shape: the app's own words are kept, a person's or repository's name is not. */
export function routeOf(path: string) {
  const parts = path.split('/').filter(Boolean);
  const word = (part?: string) => (part && WORD.test(part) ? `/${part}` : '');
  if (!parts.length) return '/';
  if (isReservedHandle(parts[0])) return `/${parts[0]}${word(parts[1])}`;
  if (parts.length === 1) return '/:owner';
  return `/:owner/:repo${word(parts[2])}`;
}
