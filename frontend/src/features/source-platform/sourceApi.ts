// Browser client for the public platform API (`/api/v1`), authenticated by the
// workspace session cookie. The UI holds no authority: every decision is the server's.
export class SourceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  if (!response.ok)
    throw new SourceApiError(
      value.error?.code ?? 'REQUEST_FAILED',
      value.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  return value as T;
}

export const shortSha = (sha: string) => sha.slice(0, 10);
export function when(ms: number | undefined) {
  return ms ? new Date(ms).toLocaleString() : '';
}
