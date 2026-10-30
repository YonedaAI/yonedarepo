// Cookieless site analytics (front Worker): one Workers Analytics Engine data point per public
// HTML page view and per sign-up, into SITE_EVENTS. A point holds only what the privacy policy
// lists (page path, referring site's host, country, device class, campaign tags, sign-up
// provider) and never an IP address, cookie, user agent or account. Analytics never decide a
// response: a missing binding or a failed write records nothing.
import type { Env } from './types';

/** Blob positions of a point, shared with the traffic queries (site-traffic.ts). */
export const SITE_EVENT_BLOBS = {
  event: 'blob1',
  path: 'blob2',
  referrer: 'blob3',
  country: 'blob4',
  device: 'blob5',
  utmSource: 'blob6',
  utmMedium: 'blob7',
  utmCampaign: 'blob8',
  provider: 'blob9',
} as const;
/** `double1`: 1 when the request looked automated, else 0. */
export const SITE_EVENT_BOT = 'double1';

export type SiteEvent = 'pageview' | 'signup';
export type Device = 'desktop' | 'mobile' | 'tablet' | 'bot';
export type SignupProvider = 'email' | 'github' | 'google';
/** Where a sign-up's visitor first landed from, as the browser reported it (untrusted). */
export type SignupSource = {
  ref: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
};

const SESSION_COOKIE = 'yoneda_account';
const UTM_LENGTH = 64;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// The signed-in app's own pages: not part of the public site even when fetched signed out.
const APP_ROOTS = new Set(['settings', 'admin', 'device', 'new', 'auth', 'api']);
// Public site sections whose full path names a page; anything else is an account or a
// repository, kept at `/<handle>/<repo>` so file paths inside a repository are never recorded.
const SITE_ROOTS = new Set([
  'features',
  'pricing',
  'docs',
  'blog',
  'company',
  'terms',
  'privacy',
  'signin',
  'signup',
  'compare',
  'build-on',
  'works-with',
]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BOT_AGENT =
  /bot|crawl|spider|slurp|scrape|curl|wget|python|httpclient|go-http|java\/|okhttp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor/i;

/** Records a page view when `res` is a public site page served to a signed-out GET. */
export function recordPageView(req: Request, res: Response, env: Env) {
  if (!env.SITE_EVENTS || !isPublicPage(req, res)) return;
  const url = new URL(req.url);
  const path = pagePath(url.pathname);
  if (!path) return;
  write(env, 'pageview', req, {
    path,
    referrer: referrerHost(req, url.hostname),
    source: readSignupSource(url.searchParams),
  });
}

/** Records a new account: how it signed up and where its visitor first landed from. */
export function recordSignup(
  env: Env,
  req: Request,
  provider: SignupProvider,
  source: SignupSource | null,
) {
  if (!env.SITE_EVENTS) return;
  const from = source ?? readSignupSource(null);
  write(env, 'signup', req, { path: '', referrer: from.ref, source: from, provider });
}

/** Whether a response is a public site page: signed-out GET, HTML, 200, not the app. */
export function isPublicPage(req: Request, res: Response) {
  if (req.method !== 'GET' || res.status !== 200) return false;
  if (!res.headers.get('content-type')?.includes('text/html')) return false;
  if (hasSession(req)) return false;
  const root = new URL(req.url).pathname.split('/')[1] ?? '';
  return !APP_ROOTS.has(root);
}

/** A sign-up source from a JSON body or query parameters, validated and trimmed. */
export function readSignupSource(input: unknown): SignupSource {
  const field = (name: string): unknown =>
    input instanceof URLSearchParams
      ? input.get(name)
      : input && typeof input === 'object'
        ? (input as Record<string, unknown>)[name]
        : undefined;
  const ref = field('ref');
  const host = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
  return {
    ref: HOST.test(host) ? host : '',
    utm_source: tag(field('utm_source')),
    utm_medium: tag(field('utm_medium')),
    utm_campaign: tag(field('utm_campaign')),
  };
}

// An OAuth sign-up's source rides in its stored return path (the only free-form field the
// attempt keeps), under one reserved parameter that the callback always removes.
const CARRIED = 'yoneda_signup_source';
const RETURN_PATH_LIMIT = 512;

/** The return path with the source appended, or unchanged when empty or out of room. */
export function withSignupSource(path: string, source: SignupSource) {
  if (!source.ref && !source.utm_source && !source.utm_medium && !source.utm_campaign) return path;
  const carried = new URLSearchParams(Object.entries(source).filter(([, v]) => v)).toString();
  const joined = `${path}${path.includes('?') ? '&' : '?'}${CARRIED}=${encodeURIComponent(carried)}`;
  return joined.length <= RETURN_PATH_LIMIT ? joined : path;
}

/** Splits a stored return path into the path to send the browser to and its carried source. */
export function takeSignupSource(path: string): { path: string; source: SignupSource | null } {
  const url = new URL(path, 'https://return.invalid');
  const carried = url.searchParams.get(CARRIED);
  if (carried === null) return { path, source: null };
  url.searchParams.delete(CARRIED);
  return {
    path: `${url.pathname}${url.search}${url.hash}`,
    source: readSignupSource(new URLSearchParams(carried)),
  };
}

function write(
  env: Env,
  event: SiteEvent,
  req: Request,
  point: { path: string; referrer: string; source: SignupSource; provider?: SignupProvider },
) {
  const device = deviceOf(req);
  try {
    env.SITE_EVENTS?.writeDataPoint({
      indexes: [event],
      blobs: [
        event,
        point.path,
        point.referrer,
        countryOf(req),
        device,
        point.source.utm_source,
        point.source.utm_medium,
        point.source.utm_campaign,
        point.provider ?? '',
      ],
      doubles: [device === 'bot' ? 1 : 0],
    });
  } catch {
    // A lost data point is acceptable; a failed page or sign-up is not.
  }
}

function hasSession(req: Request) {
  return (req.headers.get('cookie') ?? '')
    .split(';')
    .some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
}

/** The recorded path: site pages in full, accounts and repositories at `/<handle>[/<repo>]`. */
function pagePath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return '/';
  if (!parts.every((part) => SEGMENT.test(part))) return null;
  // A file name (`/favicon.ico`, `/robots.txt`) is not a page.
  if (/\.[a-z0-9]{1,8}$/i.test(parts[parts.length - 1]) && parts.length === 1) return null;
  const kept = SITE_ROOTS.has(parts[0]) ? parts.slice(0, 4) : parts.slice(0, 2);
  return `/${kept.join('/')}`;
}

function referrerHost(req: Request, ownHost: string) {
  try {
    const host = new URL(req.headers.get('referer') ?? '').hostname.toLowerCase();
    return host !== ownHost && HOST.test(host) ? host : '';
  } catch {
    return '';
  }
}

function countryOf(req: Request) {
  const country = (req.cf as { country?: unknown } | undefined)?.country;
  return typeof country === 'string' && /^[A-Z0-9]{2}$/.test(country) ? country : '';
}

/** Device class from the user agent; Bot Management's verdict wins where the zone has it. */
function deviceOf(req: Request): Device {
  const bm = (req.cf as { botManagement?: { score?: unknown; verifiedBot?: unknown } } | undefined)
    ?.botManagement;
  if (bm?.verifiedBot === true || (typeof bm?.score === 'number' && bm.score < 30)) return 'bot';
  const agent = req.headers.get('user-agent') ?? '';
  if (!agent || BOT_AGENT.test(agent)) return 'bot';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(agent)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(agent)) return 'mobile';
  return 'desktop';
}

function tag(value: unknown) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\w .+-]/g, '')
    .trim()
    .slice(0, UTM_LENGTH);
}
