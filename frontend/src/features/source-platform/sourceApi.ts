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

export async function sourceApi<T = any>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    credentials: 'same-origin',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = value.error?.code ?? 'REQUEST_FAILED';
    const repo = code === 'GONE' ? REPO_PATH.exec(path)?.[1] : undefined;
    if (repo) for (const listener of goneListeners) listener(repo);
    throw new SourceApiError(
      code,
      value.error?.message ?? `Request failed (${response.status})`,
      response.status,
      value.error?.details,
    );
  }
  return value as T;
}

export const shortSha = (sha: string) => sha.slice(0, 10);
export function when(ms: number | undefined) {
  return ms ? new Date(ms).toLocaleString() : '';
}
