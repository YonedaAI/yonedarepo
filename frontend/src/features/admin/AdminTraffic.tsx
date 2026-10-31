// Admin traffic: the site's cookieless analytics (platform-site-traffic.ts) as humans, agents and
// bots: a headline, each class per day for 30 days, platform use by client kind and Cloudflare Web
// Analytics beside our own count, then the top pages, referrers and countries of the class the
// filter picks (Humans first), campaigns and sign-ups by source over the chosen window (7 or 30
// days). Page views, not visitors: nothing identifies a visitor.
import { useState } from 'react';
import type {
  SiteTrafficResult,
  TrafficClass,
  TrafficCount,
  TrafficWindow,
} from '../../../../shared/site-traffic';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { DayChart } from './AdminParts';
import {
  PlatformClients,
  TrafficCheck,
  TrafficClassNote,
  TrafficHeadlineCards,
} from './AdminTrafficCheck';
import { countryName, lastThirtyDays, providerLabel } from './adminModel';

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const CLASSES: { id: TrafficClass; label: string }[] = [
  { id: 'humans', label: 'Humans' },
  { id: 'agents', label: 'Agents' },
  { id: 'bots', label: 'Bots and unconfirmed' },
];

function TopList({
  id,
  title,
  rows,
  label,
  name = (key) => key,
}: {
  id: string;
  title: string;
  rows: TrafficCount[];
  /** The key column's heading. */
  label: string;
  name?: (key: string) => string;
}) {
  return (
    <section className="home-section admin-top" aria-labelledby={id}>
      <h2 id={id} className="home-label">
        {title}
      </h2>
      {rows.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>{label}</th>
                <th className="admin-num">Views</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="admin-key">{name(r.key)}</td>
                  <td className="admin-num">{count(r.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">None in this window.</p>
      )}
    </section>
  );
}

export function AdminTraffic() {
  const [days, setDays] = useState<TrafficWindow>(7);
  const [who, setWho] = useState<TrafficClass>('humans');
  const report = useSource<SiteTrafficResult>(`/admin/traffic?days=${days}&class=${who}`);
  const windowPicker = (
    <fieldset className="admin-window">
      <legend className="sr-only">Window</legend>
      {([7, 30] as const).map((n) => (
        <button
          key={n}
          type="button"
          className="quiet"
          aria-pressed={days === n}
          onClick={() => setDays(n)}
        >
          {n} days
        </button>
      ))}
    </fieldset>
  );
  if (report.loading && !report.data)
    return (
      <>
        {windowPicker}
        <Loading what="site traffic" />
      </>
    );
  if (report.error || !report.data)
    return <Failure error={report.error ?? ''} what="site traffic" onRetry={report.reload} />;
  if (!report.data.ok)
    return report.data.reason === 'not_configured' ? (
      <p className="source-empty">
        Site traffic is not configured on this platform: it needs CF_ACCOUNT_ID, SITE_EVENTS_DATASET
        and the ANALYTICS_READ_TOKEN secret.
      </p>
    ) : (
      <Failure error="The analytics query failed. Try again in a minute." onRetry={report.reload} />
    );
  const t = report.data.traffic;
  const signups = days === 7 ? t.signups.last_7 : t.signups.last_30;
  const series = (name: TrafficClass) =>
    lastThirtyDays(t.by_day.map((d) => ({ day: d.day, views: d[name] })));
  return (
    <>
      {windowPicker}
      <p className="source-meta">
        Page views, not unique visitors: nothing identifies a visitor, so none are counted. Counts
        are sampled.
      </p>
      <TrafficClassNote since={t.classed_since} />
      <TrafficHeadlineCards headline={t.headline} />
      <div className="admin-grid">
        {CLASSES.map(({ id, label }) => (
          <DayChart
            key={id}
            id={`admin-${id}-chart`}
            title={`${label}, last 30 days`}
            unit={id === 'humans' ? 'views' : 'requests'}
            days={series(id)}
          />
        ))}
      </div>
      <PlatformClients days={t.days} clients={t.clients} />
      <TrafficCheck days={t.days} humans={t.headline.humans} web_analytics={t.web_analytics} />
      <fieldset className="admin-window">
        <legend className="sr-only">Whose pages, referrers and countries</legend>
        {CLASSES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="quiet"
            aria-pressed={who === id}
            onClick={() => setWho(id)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {t.class === 'bots' && (
        <p className="source-meta">
          Paths here include what scanners asked for, such as /wp. Those are not pages. Anything
          after a path's first segment is never recorded.
        </p>
      )}
      <div className="admin-grid">
        <TopList id="admin-top-pages" title="Top pages" label="Path" rows={t.top_pages} />
        <TopList
          id="admin-top-referrers"
          title="Top referrers"
          label="Site"
          rows={t.top_referrers}
        />
        <TopList
          id="admin-countries"
          title="Countries"
          label="Country"
          rows={t.countries}
          name={countryName}
        />
      </div>
      <section className="home-section" aria-labelledby="admin-campaigns">
        <h2 id="admin-campaigns" className="home-label">
          Campaigns
        </h2>
        <p className="source-meta">
          From page requests that looked like browsers: the ping carries no campaign tags.
        </p>
        {t.campaigns.length ? (
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Medium</th>
                  <th>Campaign</th>
                  <th className="admin-num">Views</th>
                </tr>
              </thead>
              <tbody>
                {t.campaigns.map((c) => (
                  <tr key={`${c.utm_source}/${c.utm_medium}/${c.utm_campaign}`}>
                    <td>{c.utm_source || '—'}</td>
                    <td>{c.utm_medium || '—'}</td>
                    <td>{c.utm_campaign || '—'}</td>
                    <td className="admin-num">{count(c.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="source-empty">No tagged (UTM) visits in this window.</p>
        )}
      </section>
      <section className="home-section" aria-labelledby="admin-signup-sources">
        <h2 id="admin-signup-sources" className="home-label">
          Sign-ups by source, last {days} days
        </h2>
        {signups.length ? (
          <div className="source-table-wrap">
            <table className="source-table admin-table">
              <thead>
                <tr>
                  <th>Signed up with</th>
                  <th>Referrer</th>
                  <th>Source</th>
                  <th>Campaign</th>
                  <th className="admin-num">Sign-ups</th>
                </tr>
              </thead>
              <tbody>
                {signups.map((s) => (
                  <tr key={`${s.provider}/${s.referrer}/${s.utm_source}/${s.utm_campaign}`}>
                    <td>{providerLabel(s.provider)}</td>
                    <td>{s.referrer || 'direct'}</td>
                    <td>{s.utm_source || '—'}</td>
                    <td>{s.utm_campaign || '—'}</td>
                    <td className="admin-num">{count(s.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="source-empty">No sign-ups in this window.</p>
        )}
      </section>
    </>
  );
}
