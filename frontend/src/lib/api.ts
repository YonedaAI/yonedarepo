export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const controller = new AbortController();
  const timeoutError = new ApiError(
    'REQUEST_TIMEOUT',
    'The request timed out. Refresh to check its latest status before retrying.',
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, 20_000);
  });
  const request = (async () => {
    const response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok)
      throw new ApiError(
        value.error?.code ?? 'REQUEST_FAILED',
        value.error?.message ?? 'Request failed',
      );
    return value as T;
  })();
  try {
    // Bound the caller even when a transport ignores abort; mutations are never retried here.
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export const short = (commit: string) => commit?.slice(0, 9) ?? '—';

export async function connectOwner(token: string) {
  const result = await fetch('/api/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!result.ok) throw new Error('Owner connection failed');
}
export async function disconnectOwner() {
  await fetch('/api/session', { method: 'DELETE' });
}
