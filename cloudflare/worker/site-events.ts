// Cookieless site analytics (front Worker): one Workers Analytics Engine data point per signed-out
// HTML request and per sign-up, into SITE_EVENTS. Page requests stay signed out even though a
// signed-in reader counts through the ping (site-ping.ts): an unknown path keeps its first segment,
// which on a signed-in request would be an account's handle, and the Web Analytics beacon reports
// every address it sees to Cloudflare, which there would name private repositories. A point holds
// only what the privacy policy lists (page path, referring site's host, country, device class,
// campaign tags, sign-up provider, the request's class) and never an IP address, cookie, user
// agent or account (the platform's `write_origin` points, platform-write-origin.ts, are the one
// kind that names a digest of an account, and are off until the owner clears them). Analytics
// never decide a response: a missing binding or a failed write records nothing. The app answers
// 200 at any path, so a request records the page the head found, or, for anything else, its first
// segment only: scanners' `/wp` stays visible, and nothing inside a repository is ever recorded.
// The check uses what the head already found (website-metadata.ts), never a call of its own. Who a
// request was is decided later: it stays unconfirmed unless the page's ping confirms a browser
// (site-ping.ts), and the traffic queries take pings away from the unconfirmed.
import { pageClass, type SiteClass, userAgentClass } from './traffic-class';
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
  class: 'blob10',
  /** Platform points only (platform-client-events.ts). */
  client: 'blob11',
  operation: 'blob12',
  /** `write_origin` points only (platform-write-origin.ts); `index1` is the writer's digest. */
  continent: 'blob13',
  writerKind: 'blob14',
  /** Platform points, in the same places: `outcome` with TRAFFIC_REPORT on, the rest with
   * REPO_ANALYTICS on (repo-usage.ts). `repo` is empty unless the request was admitted. */
  outcome: 'blob13',
  repo: 'blob14',
  actor: 'blob15',
  reason: 'blob16',
  detail: 'blob17',
} as const;
/** `double1`: 1 when the request looked automated, else 0. */
export const SITE_EVENT_BOT = 'double1';
/** `double2`: 1 on every point since requests are classed; older points have none, so the
 * earliest one dates the classes in each environment. */
export const SITE_EVENT_CLASSED = 'double2';
/** Platform points only: `double3` is the requests one point stands for, `double4` is 1 when a
 * token held, and `double5` is 1 since our tools carry the mark below: earlier points are our own
 * tests (on dev, all 8,237 came from one machine in the four hours before this) and stay out. */
export const SITE_EVENT_WEIGHT = 'double3';
export const SITE_EVENT_TOKEN = 'double4';
export const SITE_EVENT_MARKED = 'double5';
/** Platform points with TRAFFIC_REPORT on: milliseconds until the answer's headers. A streamed
 * clone or push goes on after that. */
export const SITE_EVENT_DURATION = 'double6';
/** Platform points with REPO_ANALYTICS on: the pack's bytes, the wait in a landing's queue in
 * milliseconds, and the rounds the platform repeated a landing. With a pack, `double6` runs to
 * its last byte. */
export const SITE_EVENT_BYTES = 'double7';
export const SITE_EVENT_QUEUE = 'double8';
export const SITE_EVENT_RETRIES = 'double9';
/** Our own tools send this, set to `1` (tools/own-traffic.mjs): they are not counted. It unlocks
 * nothing: anyone sending it only leaves the analytics. */
export const OWN_TRAFFIC_HEADER = 'x-yoneda-own-traffic';

export type SiteEvent = 'pageview' | 'ping' | 'signup';
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
export const APP_PAGES = new Map([
  ['/explore', '/source/explore'],
  ['/source/explore', '/source/explore'],
]);
// A path's first segment, when it is not a page. Anything else (an email address, a very long
// name) is kept out: these paths come from strangers.
const FIRST_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const OTHER_PATH = '/(other)';

/** Records a signed-out request for a page, at `canonical` when the head found the page exists
 * (absent for any unknown path or private repository, whose name is therefore never recorded). */
export function recordPageView(
  req: Request,
  res: Response,
  canonical: string | undefined,
  env: Env,
) {
  if (!env.SITE_EVENTS || !isAnonymousHtml(req, res)) return;
  const url = new URL(req.url);
  const seen = pageClass(req);
  writeSitePoint(env, 'pageview', req, {
    path: canonical ?? APP_PAGES.get(url.pathname) ?? unknownPath(url.pathname),
    referrer: referrerName(refererHost(req), url.hostname),
    source: readSignupSource(url.searchParams),
    class: seen,
    automated: seen !== 'unconfirmed',
  });
}

/** Records a new account: how it signed up and where its visitor first landed from. */
export function recordSignup(
  env: Env,
  req: Request,
  provider: SignupProvider,
  source: SignupSource | null,
) {
  if (!env.SITE_EVENTS || isOwnTraffic(req)) return;
  const from = source ?? readSignupSource(null);
  writeSitePoint(env, 'signup', req, {
    path: '',
    referrer: from.ref,
    source: from,
    provider,
    class: '',
    automated: userAgentClass(req.headers.get('user-agent') ?? '') !== null,
  });
}

/** Whether analytics may see a response: a signed-out GET of HTML, answered 200, not our tests. */
function isAnonymousHtml(req: Request, res: Response) {
  if (req.method !== 'GET' || res.status !== 200) return false;
  if (!res.headers.get('content-type')?.includes('text/html')) return false;
  return !hasSession(req) && !isOwnTraffic(req);
}

/** Whether a response is a public site page, which may carry the beacon: not the app. */
export function isPublicPage(req: Request, res: Response) {
  if (!isAnonymousHtml(req, res)) return false;
  const root = new URL(req.url).pathname.split('/')[1] ?? '';
  return !APP_ROOTS.has(root);
}

export const isOwnTraffic = (req: Request) => req.headers.get(OWN_TRAFFIC_HEADER) === '1';

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

/** Writes one point; a failed write loses that point and nothing else. */
export function writeSitePoint(
  env: Env,
  event: SiteEvent,
  req: Request,
  point: {
    path: string;
    referrer: string;
    source: SignupSource;
    provider?: SignupProvider;
    class: SiteClass | '';
    automated: boolean;
  },
) {
  try {
    env.SITE_EVENTS?.writeDataPoint({
      indexes: [event],
      blobs: [
        event,
        point.path,
        point.referrer,
        countryOf(req),
        deviceOf(req, point.automated),
        point.source.utm_source,
        point.source.utm_medium,
        point.source.utm_campaign,
        point.provider ?? '',
        point.class,
      ],
      doubles: [point.automated ? 1 : 0, 1],
    });
  } catch {
    // A lost data point is acceptable; a failed page or sign-up is not.
  }
}

export function hasSession(req: Request) {
  return (req.headers.get('cookie') ?? '')
    .split(';')
    .some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
}

function unknownPath(pathname: string) {
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  return FIRST_SEGMENT.test(first) ? `/${first}` : OTHER_PATH;
}

function refererHost(req: Request) {
  try {
    return new URL(req.headers.get('referer') ?? '').hostname;
  } catch {
    return '';
  }
}

/** A referring site's name, or nothing for this site's own or anything that is not a host. */
export function referrerName(value: unknown, ownHost: string) {
  const host = typeof value === 'string' ? value.toLowerCase() : '';
  return host !== ownHost && HOST.test(host) ? host : '';
}

export function countryOf(req: Request) {
  const country = (req.cf as { country?: unknown } | undefined)?.country;
  return typeof country === 'string' && /^[A-Z0-9]{2}$/.test(country) ? country : '';
}

function deviceOf(req: Request, automated: boolean): Device {
  if (automated) return 'bot';
  const agent = req.headers.get('user-agent') ?? '';
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
