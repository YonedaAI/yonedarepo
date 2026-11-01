// Admin traffic: the site's cookieless analytics (platform-site-traffic.ts) as humans, agents and
// bots: one line on whether the numbers can be trusted yet, a headline, each class per day for 30
// days, platform use by client kind and Cloudflare Web Analytics beside our own count, then the
// top pages, referrers and countries of the class the filter picks (Humans first), campaigns and
// sign-ups by source over the chosen window (7 or 30 days).
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
import { PlatformClients, TrafficCheck, TrafficHeadlineCards } from './AdminTrafficCheck';
import {
  countryName,
  lastThirtyDays,
  providerLabel,
  trafficEmpty,
  trafficNote,
} from './adminModel';

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const CLASSES: { id: TrafficClass; label: string }[] = [
  { id: 'humans', label: 'Humans' },
  { id: 'agents', label: 'Agents' },
  { id: 'bots', label: 'Bots' },
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

/** A class's 30 days, or one line when there is nothing to draw. */
function ClassChart({
  id,
  label,
  unit,
  days,
  none = 'None in the last 30 days.',
}: {
  id: TrafficClass;
  label: string;
  unit: string;
  days: { day: string; count: number }[];
  /** The line when there is nothing to draw. */
  none?: string;
}) {
  const heading = `admin-${id}-chart`;
  const title = `${label}, 30 days`;
  if (days.some((d) => d.count > 0))
    return <DayChart id={heading} title={title} unit={unit} days={days} />;
  return (
    <section className="home-section" aria-labelledby={heading}>
      <h2 id={heading} className="home-label">
        {title}
      </h2>
      <p className="source-empty">{none}</p>
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
  const head = (note?: { text: string; warn: boolean }) => (
    <div className="admin-traffic-row">
      <p className="source-meta">{note?.warn ? <strong>{note.text}</strong> : note?.text}</p>
      {windowPicker}
    </div>
  );
  if (report.loading && !report.data)
    return (
      <>
        {head()}
        <Loading what="site traffic" />
      </>
    );
  if (report.error || !report.data)
    return <Failure error={report.error ?? ''} what="site traffic" onRetry={report.reload} />;
  if (!report.data.ok)
    return report.data.reason === 'not_configured' ? (
      <p className="source-empty">Site traffic is not set up here.</p>
    ) : (
      <Failure error="The analytics query failed. Try again in a minute." onRetry={report.reload} />
    );
  const t = report.data.traffic;
  const note = trafficNote(t);
  const signups = days === 7 ? t.signups.last_7 : t.signups.last_30;
  if (trafficEmpty(t))
    return (
      <>
        {head(note)}
        {!note.warn && <p className="source-empty">No traffic in the last 30 days.</p>}
      </>
    );
  const series = (name: TrafficClass) =>
    lastThirtyDays(t.by_day.map((d) => ({ day: d.day, views: d[name] })));
  return (
    <>
      {head(note)}
      <TrafficHeadlineCards headline={t.headline} counting={t.counting} />
      <div className="admin-grid">
        {CLASSES.map(({ id, label }) => (
          <ClassChart
            key={id}
            id={id}
            label={label}
            unit={id === 'humans' ? 'views' : 'requests'}
            days={series(id)}
            none={id === 'humans' && !t.counting ? 'Not counted here yet.' : undefined}
          />
        ))}
      </div>
      <PlatformClients days={t.days} clients={t.clients} counting={t.counting} />
      <TrafficCheck
        days={t.days}
        humans={t.headline.humans - t.headline.humans_signed_in}
        counting={t.counting}
        web_analytics={t.web_analytics}
      />
      <div className="admin-traffic-row">
        <h2 className="home-label">Breakdown, last {days} days</h2>
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
      </div>
      <div className="admin-grid">
        <TopList
          id="admin-top-pages"
          title={t.class === 'bots' ? 'Top paths' : 'Top pages'}
          label="Path"
          rows={t.top_pages}
        />
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
