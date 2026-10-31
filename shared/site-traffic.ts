// The admin Traffic page's wire shape: cookieless site analytics read back from Workers
// Analytics Engine (cloudflare/worker/platform-site-traffic.ts). Counts are sampled page views and
// sign-ups, not unique visitors: nothing identifies a visitor, so none can be counted. Web
// Analytics' figures are Cloudflare's own, from the beacon, shown beside them as a cross-check.

export type TrafficWindow = 7 | 30;

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

export interface SiteTraffic {
  /** The window of the top lists and campaigns, in days. */
  days: TrafficWindow;
  /** The UTC day (`YYYY-MM-DD`) of the earliest page view under the real-pages rule, null when
   * there is none yet. Rows before it hold unknown paths and can't be cleaned. */
  filtered_since: string | null;
  /** Non-bot page views over `days`. */
  views_total: number;
  web_analytics: WebAnalyticsCheck;
  /** Non-bot page views per UTC day over the last 30 days (`YYYY-MM-DD`), oldest first. */
  views_by_day: { day: string; views: number }[];
  top_pages: TrafficCount[];
  /** Referring sites by host; direct visits (no referrer) are left out. */
  top_referrers: TrafficCount[];
  /** ISO 3166 country codes as Cloudflare reports them. */
  countries: TrafficCount[];
  campaigns: TrafficCampaign[];
  /** New accounts by provider and landing source over the last 7 and 30 days. */
  signups: { last_7: TrafficSignupSource[]; last_30: TrafficSignupSource[] };
}

export type SiteTrafficResult =
  | { ok: true; traffic: SiteTraffic }
  /** `not_configured`: the account id, dataset or read token is unset. `query_failed`: the
   * Analytics Engine SQL API refused or failed a query. */
  | { ok: false; reason: 'not_configured' | 'query_failed' };
