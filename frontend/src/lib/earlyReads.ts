import { plainNamedOverview } from './overviewEntryRoute';

type EarlyRead = { response: Promise<Response>; release: () => void };
type EarlyHandoff = {
  version: 2;
  take: (url: string, signal?: AbortSignal) => EarlyRead | undefined;
  clear: () => void;
};

declare global {
  interface Window {
    __yonedaEarlyReads?: EarlyHandoff;
  }
}

/** Vite supplies serialized dependencies. Exact URL adoption plus fresh session discovery
 * and normal API authorization remain mandatory. */
export function beginEarlyReads(
  target: Window,
  reservedRoots: readonly string[],
  namedOverview = plainNamedOverview,
) {
  target.__yonedaEarlyReads?.clear();
  const locationKey = () =>
    target.location.pathname + target.location.search + target.location.hash;
  const documentKey = locationKey();
  const entries = new Map<string, { response: Promise<Response>; controller: AbortController }>();
  const controllers = new Set<AbortController>();
  const deadline = Date.now() + 30_000;
  let cleared = false;
  let timer: ReturnType<typeof setTimeout>;
  const clear = () => {
    cleared = true;
    clearTimeout(timer);
    entries.clear();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    target.removeEventListener('pagehide', clear);
  };
  const start = (url: string) => {
    const controller = new AbortController();
    controllers.add(controller);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    let transport: Promise<Response>;
    try {
      transport = fetch(url, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch (error) {
      transport = Promise.reject(error);
    }
    const response = Promise.race([transport, aborted]);
    void response.catch(() => {});
    entries.set(url, { response, controller });
  };
  target.__yonedaEarlyReads = {
    version: 2,
    clear,
    take(url, signal) {
      if (cleared || Date.now() > deadline || locationKey() !== documentKey) {
        clear();
        return undefined;
      }
      const entry = entries.get(url);
      if (!entry) return undefined;
      entries.delete(url);
      // Adoption transfers cancellation to the consumer scope.
      controllers.delete(entry.controller);
      const cancel = () => entry.controller.abort(signal?.reason);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      return {
        // Headers are not completion: the caller owns cancellation through body parsing.
        response: entry.response.then((response) => {
          if (entry.controller.signal.aborted)
            throw (
              entry.controller.signal.reason ?? new DOMException('Read cancelled', 'AbortError')
            );
          return response;
        }),
        release: () => signal?.removeEventListener('abort', cancel),
      };
    },
  };
  timer = setTimeout(clear, 30_000);
  target.addEventListener('pagehide', clear, { once: true });
  start('/api/auth/session?summary=true');
  if (documentKey === '/agents') start('/api/managed/self');
  const named = namedOverview(target.location, reservedRoots);
  if (named)
    start(
      `/api/v1/resolve/${named.owner}/${encodeURIComponent(named.name)}?summary=true&overview=true&ref=main`,
    );
}

/** Only the exact initial document can donate a response; subsequent reads stay fresh. */
export function takeEarlyResponse(url: string, signal?: AbortSignal) {
  const handoff = typeof window === 'undefined' ? undefined : window.__yonedaEarlyReads;
  return handoff?.version === 2 ? handoff.take(url, signal) : undefined;
}

export function clearEarlyReads() {
  if (typeof window !== 'undefined') window.__yonedaEarlyReads?.clear();
}
