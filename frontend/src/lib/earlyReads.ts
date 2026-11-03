type EarlyHandoff = {
  version: 1;
  take: (url: string, signal?: AbortSignal) => Promise<Response> | undefined;
  clear: () => void;
};

declare global {
  interface Window {
    __yonedaEarlyReads?: EarlyHandoff;
  }
}

/** Serialized into the document head by Vite; keep every runtime dependency inside it. */
export function beginEarlyReads(target: Window, reservedRoots: readonly string[]) {
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
    // A failed early read may precede its consumer; preserve the rejection for that consumer.
    void response.catch(() => {});
    entries.set(url, { response, controller });
  };
  target.__yonedaEarlyReads = {
    version: 1,
    clear,
    take(url, signal) {
      if (cleared || Date.now() > deadline || locationKey() !== documentKey) {
        clear();
        return undefined;
      }
      const entry = entries.get(url);
      if (!entry) return undefined;
      entries.delete(url);
      // Adoption transfers cancellation to the existing request scope. A resolver may
      // navigate while session discovery is still pending; it must not cancel that scope.
      controllers.delete(entry.controller);
      const cancel = () => entry.controller.abort(signal?.reason);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      return entry.response
        .then((response) => {
          if (entry.controller.signal.aborted)
            throw (
              entry.controller.signal.reason ?? new DOMException('Read cancelled', 'AbortError')
            );
          return response;
        })
        .finally(() => signal?.removeEventListener('abort', cancel));
    },
  };
  timer = setTimeout(clear, 30_000);
  target.addEventListener('pagehide', clear, { once: true });
  start('/api/auth/session?summary=true');
  // Restrict the head request to the plain named Overview contract. Other routes use
  // their normal parser; a future route cannot accidentally opt into private prefetch.
  const match = /^\/([a-z][a-z0-9_]{2,31})\/((?!\.)[A-Za-z0-9._-]{1,100})\/?$/.exec(
    target.location.pathname,
  );
  const reserved = new Set(reservedRoots);
  const owner = match?.[1];
  const name = match?.[2];
  if (owner && name && !reserved.has(owner) && !target.location.search && !target.location.hash)
    start(
      `/api/v1/resolve/${owner}/${encodeURIComponent(name)}?summary=true&overview=true&ref=main`,
    );
}

/** Only the exact initial document can donate a response; subsequent reads stay fresh. */
export function takeEarlyResponse(url: string, signal?: AbortSignal) {
  const handoff = typeof window === 'undefined' ? undefined : window.__yonedaEarlyReads;
  return handoff?.version === 1 ? handoff.take(url, signal) : undefined;
}

export function clearEarlyReads() {
  if (typeof window !== 'undefined') window.__yonedaEarlyReads?.clear();
}
