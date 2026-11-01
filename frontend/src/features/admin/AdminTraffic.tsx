// Admin traffic: the site's cookieless analytics (platform-site-traffic.ts) as humans, agents and
// bots, all over the chosen range: one line on whether the numbers can be trusted yet, a headline
// with the period before, each class over time, platform use by client kind and Cloudflare Web
// Analytics beside our own count, then the top pages, referrers and countries of the class the
// filter picks (Humans first), campaigns and sign-ups by source.
import { useRef, useState } from 'react';
import type {
  SiteTrafficResult,
  TrafficClass,
  TrafficCount,
  TrafficRange,
} from '../../../../shared/site-traffic';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useSource } from '../source-platform/useSource';
import { AdminLandings } from './AdminLandings';
import { PlatformClients, TrafficCheck, TrafficHeadlineCards } from './AdminTrafficCheck';
import { countryName, providerLabel } from './adminModel';
import { TimeChart } from './TimeChart';
import {
  type ChartBar,
  figure,
  RANGE_LABELS,
  trafficBars,
  trafficEmpty,
  trafficNote,
} from './trafficModel';

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
                  <td className="admin-num">{figure(r.count, r.estimated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">None in this range.</p>
      )}
    </section>
  );
}

/** A class over the range, or one line when there is nothing to draw. */
function ClassChart({
  id,
  label,
  unit,
  bars,
  none = 'None in this range.',
}: {
  id: TrafficClass;
  label: string;
  unit: string;
  bars: ChartBar[];
  /** The line when there is nothing to draw. */
  none?: string;
}) {
  const heading = `admin-${id}-chart`;
  if (bars.some((b) => b.value > 0))
    return <TimeChart id={heading} title={label} unit={unit} bars={bars} />;
  return (
    <section className="home-section" aria-labelledby={heading}>
      <h2 id={heading} className="home-label">
        {label}
      </h2>
      <p className="source-empty">{none}</p>
    </section>
  );
}

export function AdminTraffic() {
  const [range, setRange] = useState<TrafficRange>('7d');
  const [who, setWho] = useState<TrafficClass>('humans');
  const report = useSource<SiteTrafficResult>(`/admin/traffic?range=${range}&class=${who}`);
  // What's offered comes with the first answer, and stays while another range loads.
  const offered = useRef<TrafficRange[]>([]);
  if (report.data?.ok) offered.current = report.data.traffic.ranges;
  const windowPicker = (
    <fieldset className="admin-window">
      <legend className="sr-only">Range</legend>
      {(offered.current.length ? offered.current : [range]).map((id) => (
        <button
          key={id}
          type="button"
          className="quiet"
          aria-pressed={range === id}
          onClick={() => setRange(id)}
        >
          {RANGE_LABELS[id]}
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
  const period = RANGE_LABELS[t.range];
  if (trafficEmpty(t))
    return (
      <>
        {head(note)}
        {!note.warn && <p className="source-empty">No traffic in the last {period}.</p>}
        {t.repo_analytics && <AdminLandings range={t.range} />}
      </>
    );
  return (
    <>
      {head(note)}
      <TrafficHeadlineCards
        headline={t.headline}
        previous={t.previous}
        range={t.range}
        counting={t.counting}
      />
      <div className="admin-grid">
        {CLASSES.map(({ id, label }) => (
          <ClassChart
            key={id}
            id={id}
            label={label}
            unit={id === 'humans' ? 'views' : 'requests'}
            bars={trafficBars(t, id)}
            none={id === 'humans' && !t.counting ? 'Not counted here yet.' : undefined}
          />
        ))}
      </div>
      <PlatformClients range={t.range} clients={t.clients} counting={t.counting} />
      {t.repo_analytics && <AdminLandings range={t.range} />}
      <TrafficCheck
        range={t.range}
        humans={t.headline.humans - t.headline.humans_signed_in}
        counting={t.counting}
        web_analytics={t.web_analytics}
      />
      <div className="admin-traffic-row">
        <h2 className="home-label">Breakdown, last {period}</h2>
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
                    <td className="admin-num">{figure(c.count, c.estimated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="source-empty">No tagged (UTM) visits in this range.</p>
        )}
      </section>
      <section className="home-section" aria-labelledby="admin-signup-sources">
        <h2 id="admin-signup-sources" className="home-label">
          Sign-ups by source, last {period}
        </h2>
        {t.signups.length ? (
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
                {t.signups.map((s) => (
                  <tr key={`${s.provider}/${s.referrer}/${s.utm_source}/${s.utm_campaign}`}>
                    <td>{providerLabel(s.provider)}</td>
                    <td>{s.referrer || 'direct'}</td>
                    <td>{s.utm_source || '—'}</td>
                    <td>{s.utm_campaign || '—'}</td>
                    <td className="admin-num">{figure(s.count, s.estimated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="source-empty">No sign-ups in this range.</p>
        )}
      </section>
    </>
  );
}
