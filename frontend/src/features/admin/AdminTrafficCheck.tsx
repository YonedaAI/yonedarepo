// The Traffic page's honesty notes: when the page-view filter began, and the Worker's count beside
// Cloudflare Web Analytics', with what each one measures. A Web Analytics failure stays here.
import type { TrafficWindow, WebAnalyticsCheck } from '../../../../shared/site-traffic';

const count = (n: number) => Math.round(n).toLocaleString('en-US');

export function TrafficFilterNote({ since }: { since: string | null }) {
  return (
    <p className="source-meta">
      Page views count site pages and public repositories only, without our live tests. Profiles and
      pages inside a repository are not counted.{' '}
      {since
        ? `Filtering began on ${since}. Older rows cannot be cleaned, so days before it still hold scanner paths such as /wp.`
        : 'No page view has been recorded under these rules yet: every row so far is from before them and cannot be cleaned.'}
    </p>
  );
}

export function TrafficCheck({
  days,
  views,
  web_analytics: web,
}: {
  days: TrafficWindow;
  views: number;
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
              <td>Worker page views</td>
              <td>
                Requests for real pages, seen by the server; bots flagged by our rule left out.
              </td>
              <td className="admin-num">{count(views)}</td>
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
          Web Analytics could not be read just now. The Worker's count above is unaffected.
        </p>
      )}
    </section>
  );
}
