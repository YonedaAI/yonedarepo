// What the page reports when it breaks (`POST /api/client-error`,
// cloudflare/worker/client-errors.ts): the error's message and the page's path, never its content.
// It fails silently, and a page stuck in a loop sends a handful of reports, not a flood.
const MOST_REPORTS = 5;
const MESSAGE_LIMIT = 300;

type Send = (url: string, init: RequestInit) => Promise<Pick<Response, 'headers'>>;

export function clientErrorReporter(path: () => string, send: Send) {
  const sent = new Set<string>();
  /** Reports `error` once; the reference a person can quote, when the server gave one. */
  return async (error: unknown): Promise<string | null> => {
    const message = String((error as Error)?.message ?? error).slice(0, MESSAGE_LIMIT);
    if (!message || sent.has(message) || sent.size >= MOST_REPORTS) return null;
    sent.add(message);
    try {
      const answer = await send('/api/client-error', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, route: path() }),
      });
      return answer.headers.get('x-request-id');
    } catch {
      return null; // A report that cannot be sent is one error unseen.
    }
  };
}

export const reportClientError = clientErrorReporter(
  () => window.location.pathname,
  (url, init) => fetch(url, init),
);
