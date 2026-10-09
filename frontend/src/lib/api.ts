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
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.code ?? 'REQUEST_FAILED',
      value.error?.message ?? 'Request failed',
    );
  return value;
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
