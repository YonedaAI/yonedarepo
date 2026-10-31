// Browser client for the public platform API (`/api/v1`), authenticated by the
// workspace session cookie. The UI holds no authority: every decision is the server's.
export class SourceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: { conflicts?: { path: string; kind: string; marked?: string }[] },
  ) {
    super(message);
  }
}

type GoneListener = (repo: string) => void;
const goneListeners = new Set<GoneListener>();
const REPO_PATH = /^\/repos\/(r[0-9a-f]{20})(?:[/?]|$)/;

/** Calls `listener` with the repository id whenever a read under `/repos/<id>` answers GONE
 * (the repository was deleted), so its page can replace every view with one not-found page. */
export function onRepoGone(listener: GoneListener): () => void {
  goneListeners.add(listener);
  return () => goneListeners.delete(listener);
}

/** Waits before retry `n` (1-based) of a read the server could not answer. */
export const RETRY_DELAYS_MS = [400, 1200, 3000];

/** The platform's reference for a failure ("… reference = l2hpofb8"), for support. */
export const referenceOf = (text: string) => /reference\s*[=:]\s*([\w-]+)/i.exec(text)?.[1];

/** What a server failure says to people: never the raw error, only its reference. */
export const SERVER_FAILURE = 'Something went wrong on our side.';

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export type ApiInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Where the API lives on this origin: the platform (`/api/v1`, default) or the managed
   * agents Worker (`/api/managed`), which the front Worker proxies alike. */
  base?: '/api/v1' | '/api/managed';
};

/**
 * Calls the platform API. A read (GET) the server could not answer (5xx, 503 OVERLOADED or
 * a dropped connection) is retried with backoff (RETRY_DELAYS_MS) before it fails; a write
 * is never retried here, since it may have taken effect. A server failure throws
 * SERVER_FAILURE with the platform's reference, never its raw text.
 */
export async function sourceApi<T = any>(path: string, init: ApiInit = {}): Promise<T> {
  const base = init.base ?? '/api/v1';
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const retries = method === 'GET' ? RETRY_DELAYS_MS.length : 0;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
        credentials: 'same-origin',
      });
    } catch (e) {
      if (init.signal?.aborted || attempt >= retries) {
        if (init.signal?.aborted) throw e;
        throw new SourceApiError('NETWORK', "Couldn't reach YonedaRepo. Check your connection.", 0);
      }
      await wait(RETRY_DELAYS_MS[attempt] ?? 0, init.signal);
      continue;
    }
    const value = await response.json().catch(() => ({}));
    if (response.ok) return value as T;
    // 507 is the platform's own refusal (a repository at its limit), not a fault.
    const fault = response.status >= 500 && response.status !== 507;
    if (fault && attempt < retries) {
      await wait(RETRY_DELAYS_MS[attempt] ?? 0, init.signal);
      continue;
    }
    const code = value.error?.code ?? 'REQUEST_FAILED';
    const repo = code === 'GONE' ? REPO_PATH.exec(path)?.[1] : undefined;
    if (repo) for (const listener of goneListeners) listener(repo);
    const raw = String(value.error?.message ?? `Request failed (${response.status})`);
    if (fault) {
      const reference = referenceOf(raw) ?? response.headers.get('cf-ray') ?? undefined;
      throw new SourceApiError(
        code,
        reference ? `${SERVER_FAILURE} Reference: ${reference}` : SERVER_FAILURE,
        response.status,
      );
    }
    throw new SourceApiError(code, raw, response.status, value.error?.details);
  }
}

export const shortSha = (sha: string) => sha.slice(0, 10);
export function when(ms: number | undefined) {
  return ms ? new Date(ms).toLocaleString() : '';
}

/** Calls the managed agents Worker (`/api/managed`), with sourceApi's retries and errors. */
export const managedApi = <T = any>(path: string, init: Omit<ApiInit, 'base'> = {}) =>
  sourceApi<T>(path, { ...init, base: '/api/managed' });
