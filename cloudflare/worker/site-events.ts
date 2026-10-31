// Cookieless site analytics (front Worker): one Workers Analytics Engine data point per public
// HTML page view and per sign-up, into SITE_EVENTS. A point holds only what the privacy policy
// lists (page path, referring site's host, country, device class, campaign tags, sign-up
// provider) and never an IP address, cookie, user agent or account. Analytics never decide a
// response: a missing binding or a failed write records nothing. A page view counts only for a
// page that exists: the app answers 200 at any path, so scanners' `/wp` and the like are served
// but not recorded. The check uses what the head already found (website-metadata.ts), never a
// call of its own, so a profile (`/<handle>`) and the pages inside a repository go uncounted.
import type { Env } from './types';

/** Blob positions of a point, shared with the traffic queries (platform-site-traffic.ts). */
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
/** `double2`: 1 on every point since page views count real pages only; older points have none,
 * so the earliest one dates the rule in each environment. */
export const SITE_EVENT_FILTERED = 'double2';
/** The live tests' browser sends this, set to `1` (tools/staging/client.mjs OWN_TRAFFIC): its
 * pages are not counted. It unlocks nothing: anyone sending it only leaves the analytics. */
export const OWN_TRAFFIC_HEADER = 'x-yoneda-own-traffic';

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
// The app's one public page, which stays out of search and so has no canonical address.
const APP_PAGES = new Map([
  ['/explore', '/source/explore'],
  ['/source/explore', '/source/explore'],
]);
const BOT_AGENT =
  /bot|crawl|spider|slurp|scrape|curl|wget|python|httpclient|go-http|java\/|okhttp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor/i;

/** Records a page view when `res` is a public page served to a signed-out GET and `canonical`,
 * the address the head gave it, says the page exists (absent for any unknown path or private
 * repository, whose name is therefore never recorded). */
export function recordPageView(
  req: Request,
  res: Response,
  canonical: string | undefined,
  env: Env,
) {
  if (!env.SITE_EVENTS || !isPublicPage(req, res)) return;
  const url = new URL(req.url);
  const path = canonical ?? APP_PAGES.get(url.pathname);
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

/** Whether a response is a public site page for analytics: signed-out GET, HTML, 200, not the
 * app, not our own live tests. */
export function isPublicPage(req: Request, res: Response) {
  if (req.method !== 'GET' || res.status !== 200) return false;
  if (!res.headers.get('content-type')?.includes('text/html')) return false;
  if (hasSession(req) || req.headers.get(OWN_TRAFFIC_HEADER) === '1') return false;
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
      doubles: [device === 'bot' ? 1 : 0, 1],
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
