// Web Analytics' own numbers (platform Worker, the Traffic page's cross-check): what the
// Cloudflare beacon reported for this site, read from the GraphQL Analytics API with the same
// Account Analytics Read token as the site events. The beacon needs a real browser running
// JavaScript, so it is a separate witness to the Worker's server-side count. Sites are matched by
// host: the `siteTag` filter takes a tag the beacon's site token is not. A failure here reports
// itself and leaves the rest of the Traffic page alone.
import type { WebAnalyticsCheck } from '../../shared/site-traffic';
import type { Env } from './types';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const DAY_MS = 86_400_000;
const QUERY = `query WebAnalyticsCheck($account: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer { accounts(filter: { accountTag: $account }) {
    total: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1) { count sum { visits } }
  } }
}`;

type Answer = {
  data?: {
    viewer?: { accounts?: { total?: { count?: unknown; sum?: { visits?: unknown } }[] }[] };
  };
  errors?: unknown[] | null;
};

const number = (value: unknown) => (typeof value === 'number' ? value : 0);

function siteHost(origin: string | undefined) {
  try {
    return origin ? new URL(origin).hostname : '';
  } catch {
    return '';
  }
}

/** Page loads and visits the beacon reported over the last `days` days, ending `now`, starting
 * no earlier than `since` (epoch milliseconds). */
export async function webAnalytics(
  env: Env,
  days: number,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  since = 0,
): Promise<WebAnalyticsCheck> {
  const account = env.CF_ACCOUNT_ID ?? '';
  const token = env.ANALYTICS_READ_TOKEN ?? '';
  const host = siteHost(env.WEB_ORIGIN);
  if (!account || !token || !host) return { ok: false, reason: 'not_configured' };
  const filter = {
    requestHost: host,
    bot: 0,
    datetime_geq: new Date(Math.max(now - days * DAY_MS, since)).toISOString(),
    datetime_leq: new Date(now).toISOString(),
  };
  try {
    const response = await fetcher(GRAPHQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { account, filter } }),
    });
    if (!response.ok) throw new Error(`GraphQL API answered ${response.status}`);
    const answer = (await response.json()) as Answer;
    // GraphQL reports a refused query (a token without the scope) as 200 with `errors`.
    if (answer.errors?.length) throw new Error('GraphQL API answered with errors');
    const totals = answer.data?.viewer?.accounts?.[0]?.total;
    if (!Array.isArray(totals)) throw new Error('GraphQL API answered without the account');
    return {
      ok: true,
      host,
      page_loads: number(totals[0]?.count),
      visits: number(totals[0]?.sum?.visits),
    };
  } catch (e) {
    console.error(
      JSON.stringify({ event: 'web_analytics.failed', error: String((e as Error)?.message ?? e) }),
    );
    return { ok: false, reason: 'query_failed' };
  }
}
