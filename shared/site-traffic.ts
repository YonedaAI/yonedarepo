// The admin Traffic page's wire shape: cookieless site analytics read back from Workers
// Analytics Engine (cloudflare/worker/platform-site-traffic.ts). Counts are sampled page views and
// sign-ups, not unique visitors: nothing identifies a visitor, so none can be counted.

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

export interface SiteTraffic {
  /** The window of the top lists and campaigns, in days. */
  days: TrafficWindow;
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
