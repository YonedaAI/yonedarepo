// The Traffic page's headline: humans, agents and bots, platform use by client kind, and the ping's
// count beside Cloudflare Web Analytics'. A Web Analytics failure stays in its own section.
import type {
  TrafficClient,
  TrafficHeadline,
  TrafficWindow,
  WebAnalyticsCheck,
} from '../../../../shared/site-traffic';

const count = (n: number) => Math.round(n).toLocaleString('en-US');
const UNKNOWN = '—';
const crawlers = (n: number) => `${count(n)} search crawler${n === 1 ? '' : 's'}`;
const CLIENTS: Record<string, string> = {
  cli: 'yoneda CLI',
  git: 'Git',
  mcp: 'MCP',
  token: 'API token',
};

export function TrafficHeadlineCards({
  headline: h,
  counting,
}: {
  headline: TrafficHeadline;
  counting: boolean;
}) {
  const signedOut = h.humans - h.humans_signed_in;
  const tiles = [
    {
      label: 'Humans',
      value: counting ? count(h.humans) : UNKNOWN,
      caption: counting
        ? `${count(h.humans_signed_in)} signed in, ${count(signedOut)} signed out`
        : 'Not counted here yet',
    },
    {
      label: 'Agents',
      value: count(h.agents_site + h.agents_platform),
      caption: counting
        ? `${count(h.agents_site)} on the site, ${count(h.agents_platform)} on the platform`
        : `${count(h.agents_site)} on the site; platform not counted here yet`,
    },
    {
      label: 'Bots',
      value: count(h.bots),
      caption: `${crawlers(h.crawlers)}, ${count(h.bots - h.crawlers)} unconfirmed`,
    },
  ];
  return (
    <ul className="stat-cards admin-tiles-three">
      {tiles.map((tile) => (
        <li key={tile.label} className="stat-card">
          <span className="stat-label">{tile.label}</span>
          <span className="stat-value">{tile.value}</span>
          <span className="stat-caption">{tile.caption}</span>
        </li>
      ))}
    </ul>
  );
}

export function PlatformClients({
  days,
  clients,
  counting,
}: {
  days: TrafficWindow;
  clients: TrafficClient[];
  counting: boolean;
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
                <th className="admin-num">With token</th>
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
          {counting ? 'No platform requests in this window.' : 'Not counted here yet.'}
        </p>
      )}
    </section>
  );
}

export function TrafficCheck({
  days,
  humans,
  counting,
  web_analytics: web,
}: {
  days: TrafficWindow;
  humans: number;
  counting: boolean;
  web_analytics: WebAnalyticsCheck;
}) {
  return (
    <section className="home-section" aria-labelledby="admin-traffic-check">
      <h2 id="admin-traffic-check" className="home-label">
        Cross-check, last {days} days
      </h2>
      {!counting ? (
        <p className="source-empty">Not counted here yet.</p>
      ) : web.ok ? (
        <div className="source-table-wrap">
          <table className="source-table admin-table">
            <thead>
              <tr>
                <th>Count</th>
                <th className="admin-num">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Humans, signed out</td>
                <td className="admin-num">{count(humans)}</td>
              </tr>
              <tr>
                <td>Web Analytics page loads</td>
                <td className="admin-num">{count(web.page_loads)}</td>
              </tr>
              <tr>
                <td>Web Analytics visits</td>
                <td className="admin-num">{count(web.visits)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-empty">
          {web.reason === 'not_configured'
            ? 'Web Analytics is not set up here.'
            : 'Web Analytics could not be read just now.'}
        </p>
      )}
    </section>
  );
}
