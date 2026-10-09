import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../frontend/src/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('bounds a stalled mutation and aborts it without automatically repeating the request', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    // Deliberately ignores abort: the helper must still release its caller.
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal('fetch', fetch);
  const outcome = api('projects', { request_id: 'stable-id', name: 'Site' }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(await outcome).toBeInstanceOf(ApiError);
  expect((await outcome).code).toBe('REQUEST_TIMEOUT');
  expect((await outcome).message).toContain('before retrying');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].method).toBe('POST');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the deadline active until the response JSON finishes loading', async () => {
  vi.useFakeTimers();
  const response = new Response('{}');
  const json = vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return response;
  }));
  const outcome = api('projects/repo').catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(json).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal?.aborted).toBe(true);
  expect((await outcome).code).toBe('REQUEST_TIMEOUT');
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the deadline after successful responses and preserves server error codes', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const responses = [
    new Response(JSON.stringify({ status: 'ready' })),
    new Response(JSON.stringify({ error: { code: 'REPOSITORY_DELETED', message: 'Deleted' } }), { status: 410 }),
  ];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.signal) signals.push(init.signal);
    return responses.shift();
  });
  vi.stubGlobal('fetch', fetch);
  expect(await api('projects/repo')).toEqual({ status: 'ready' });
  expect(vi.getTimerCount()).toBe(0);
  await expect(api('projects/deleted')).rejects.toMatchObject({ code: 'REPOSITORY_DELETED', message: 'Deleted' });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
