// The Traffic page's headline and honest labels: humans, agents and bots with what each one means,
// platform use by client kind, when classes began, and the ping's count beside Cloudflare Web
// Analytics'. A Web Analytics failure stays in its own section.
import type {
  TrafficClient,
  TrafficHeadline,
  TrafficWindow,
  WebAnalyticsCheck,
} from '../../../../shared/site-traffic';

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const CLIENTS: Record<string, string> = {
  cli: 'yoneda CLI',
  git: 'Git',
  mcp: 'MCP',
  token: 'API token',
};

export function TrafficClassNote({ since }: { since: string | null }) {
  return (
    <p className="source-meta">
      {since
        ? `Classes began on ${since}. Older rows have none, so they count under Bots and unconfirmed and cannot be cleaned.`
        : 'No request has been classed yet: every row so far counts under Bots and unconfirmed and cannot be cleaned.'}
    </p>
  );
}

export function TrafficHeadlineCards({ headline: h }: { headline: TrafficHeadline }) {
  const tiles = [
    {
      label: 'Humans',
      value: h.humans,
      caption: 'Browsers that ran a page. A scripted browser can pass as one.',
    },
    {
      label: 'Agents',
      value: h.agents_site + h.agents_platform,
      caption: `${count(h.agents_site)} self-identified on the site, ${count(h.agents_platform)} platform requests.`,
    },
    {
      label: 'Bots and unconfirmed',
      value: h.bots,
      caption: `${count(h.crawlers)} from search crawlers; the rest are scanners and requests no ping confirmed.`,
    },
  ];
  return (
    <>
      <ul className="stat-cards admin-tiles">
        {tiles.map((tile) => (
          <li key={tile.label} className="stat-card">
            <span className="stat-label">{tile.label}</span>
            <span className="stat-value">{count(tile.value)}</span>
            <span className="stat-caption">{tile.caption}</span>
          </li>
        ))}
      </ul>
      <p className="source-meta">
        Agents on the site are self-identified: a user agent is self-reported. A token the platform
        accepted is the one solid signal.
      </p>
    </>
  );
}

export function PlatformClients({
  days,
  clients,
}: {
  days: TrafficWindow;
  clients: TrafficClient[];
}) {
  return (
    <section className="home-section" aria-labelledby="admin-platform-clients">
      <h2 id="admin-platform-clients" className="home-label">
        Platform use, last {days} days
      </h2>
      {clients.length ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Operation</th>
                <th className="admin-num">Requests</th>
                <th className="admin-num">With a valid token</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={`${c.client}/${c.operation}`}>
                  <td>{CLIENTS[c.client] ?? c.client}</td>
                  <td>{c.operation}</td>
                  <td className="admin-num">{count(c.count)}</td>
                  <td className="admin-num">{count(c.with_token)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">
          No platform requests counted in this window. Counting needs TRAFFIC_EVENTS on.
        </p>
      )}
    </section>
  );
}

export function TrafficCheck({
  days,
  humans,
  web_analytics: web,
}: {
  days: TrafficWindow;
  humans: number;
  web_analytics: WebAnalyticsCheck;
}) {
  return (
    <section className="home-section" aria-labelledby="admin-traffic-check">
      <h2 id="admin-traffic-check" className="home-label">
        Cross-check, last {days} days
      </h2>
      <div className="source-table-wrap">
        <table className="source-table admin-table">
          <thead>
            <tr>
              <th>Count</th>
              <th>What it measures</th>
              <th className="admin-num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Humans</td>
              <td>Our own ping, sent by browsers that ran a page.</td>
              <td className="admin-num">{count(humans)}</td>
            </tr>
            {web.ok && (
              <>
                <tr>
                  <td>Web Analytics page loads</td>
                  <td>
                    Reported by the beacon on {web.host}, so only browsers that ran JavaScript;
                    Cloudflare's bot filter.
                  </td>
                  <td className="admin-num">{count(web.page_loads)}</td>
                </tr>
                <tr>
                  <td>Web Analytics visits</td>
                  <td>Visits Cloudflare derives from those page loads.</td>
                  <td className="admin-num">{count(web.visits)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      {web.ok ? (
        <p className="source-meta">
          Web Analytics figures are Cloudflare's sampled estimates: at low volume a 30-day figure
          can read lower than a 7-day one.
        </p>
      ) : web.reason === 'not_configured' ? (
        <p className="source-empty">
          Web Analytics is not configured here: it needs WEB_ORIGIN beside the traffic settings.
        </p>
      ) : (
        <p className="source-empty">
          Web Analytics could not be read just now. The count above is unaffected.
        </p>
      )}
    </section>
  );
}
