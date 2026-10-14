export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  // Repository navigation may cancel reads, never an in-flight owner mutation.
  const readSignal = body === undefined ? options?.signal : undefined;
  if (readSignal?.aborted) throw new DOMException('Read cancelled', 'AbortError');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const controller = new AbortController();
  const timeoutError = new ApiError(
    'REQUEST_TIMEOUT',
    'The request timed out. Refresh to check its latest status before retrying.',
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelRead = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancelRead = () => {
      const error = new DOMException('Read cancelled', 'AbortError');
      controller.abort(error);
      reject(error);
    };
    readSignal?.addEventListener('abort', cancelRead, { once: true });
  });
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
    return await Promise.race([request, deadline, cancelled]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    readSignal?.removeEventListener('abort', cancelRead);
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
