// The admin Traffic page's wire shape: cookieless analytics read back from Workers Analytics Engine
// (cloudflare/worker/platform-site-traffic.ts). Counts are sampled views and requests, not unique
// visitors: nothing identifies a visitor, so none can be counted. Web Analytics' figures are
// Cloudflare's own, from the beacon, shown beside them as a cross-check.

export type TrafficWindow = 7 | 30;

/** Humans: browsers that ran a page's ping, signed in or not. Agents: self-identified AI user
 * agents on the site, and platform clients. Bots: everything else, with page requests no ping
 * confirmed. */
export type TrafficClass = 'humans' | 'agents' | 'bots';

export interface TrafficCount {
  key: string;
  count: number;
}

export interface TrafficCampaign {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  count: number;
}

export interface TrafficSignupSource {
  provider: string;
  referrer: string;
  utm_source: string;
  utm_campaign: string;
  count: number;
}

/** Cloudflare Web Analytics over the report's window: bots left out by Cloudflare, and sampled. */
export type WebAnalyticsCheck =
  | { ok: true; host: string; page_loads: number; visits: number }
  /** `not_configured`: the account id, site origin or read token is unset. `query_failed`: the
   * GraphQL API refused or failed the query; the rest of the report still stands. */
  | { ok: false; reason: 'not_configured' | 'query_failed' };

/** Platform requests of one client kind and operation, weighted for sampling. */
export interface TrafficClient {
  client: string;
  operation: string;
  count: number;
  /** Those made with a token the platform accepted: the one solid signal here. */
  with_token: number;
}

export interface TrafficHeadline {
  humans: number;
  /** Those with a session, on public pages only. Our own signed-in browsers are among them. */
  humans_signed_in: number;
  /** Requests from self-identified AI user agents. */
  agents_site: number;
  agents_platform: number;
  /** Bot-flagged requests and page requests no ping confirmed, crawlers included. */
  bots: number;
  crawlers: number;
}

export interface SiteTraffic {
  /** The window of the headline, top lists and campaigns, in days. */
  days: TrafficWindow;
  /** Whose top lists these are. */
  class: TrafficClass;
  /** The UTC day (`YYYY-MM-DD`) of the earliest classed point, null when there is none yet.
   * Rows before it have no class and count nowhere. */
  classed_since: string | null;
  /** Whether pings and platform requests are being recorded here. Off, Humans and platform use
   * are unknown, not zero. */
  counting: boolean;
  headline: TrafficHeadline;
  web_analytics: WebAnalyticsCheck;
  /** Per UTC day over the last 30 days (`YYYY-MM-DD`), oldest first. */
  by_day: { day: string; humans: number; agents: number; bots: number }[];
  top_pages: TrafficCount[];
  /** Referring sites by host; direct visits (no referrer) are left out. */
  top_referrers: TrafficCount[];
  /** ISO 3166 country codes as Cloudflare reports them. */
  countries: TrafficCount[];
  /** Platform requests over the window. */
  clients: TrafficClient[];
  /** From page requests that looked like browsers: a ping carries no campaign tags. */
  campaigns: TrafficCampaign[];
  /** New accounts by provider and landing source over the last 7 and 30 days. */
  signups: { last_7: TrafficSignupSource[]; last_30: TrafficSignupSource[] };
}

export type SiteTrafficResult =
  | { ok: true; traffic: SiteTraffic }
  /** `not_configured`: the account id, dataset or read token is unset. `query_failed`: the
   * Analytics Engine SQL API refused or failed a query. */
  | { ok: false; reason: 'not_configured' | 'query_failed' };
