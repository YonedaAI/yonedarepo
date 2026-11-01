// The page's one ping (`POST /api/e`, cloudflare/worker/site-ping.ts): proof that a browser ran
// this page, which is what makes a Human view on the admin Traffic page. It carries the path and
// the referring site's name only, sets no cookie and fails silently.
type Page = {
  location: Pick<Location, 'pathname'>;
  referrer: string;
  sendBeacon: (url: string, data: Blob) => boolean;
};

function hostOf(referrer: string) {
  try {
    return new URL(referrer).hostname;
  } catch {
    return '';
  }
}

export function sendPagePing({ location, referrer, sendBeacon }: Page) {
  try {
    const body = JSON.stringify({ path: location.pathname, referrer: hostOf(referrer) });
    sendBeacon('/api/e', new Blob([body], { type: 'application/json' }));
  } catch {
    // A blocked beacon is one uncounted view.
  }
}
