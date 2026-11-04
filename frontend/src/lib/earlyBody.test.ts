import { afterEach, expect, it, vi } from 'vitest';
import { RESERVED_HANDLES } from '../../../shared/account';
import { sourceApi } from '../features/source-platform/sourceApi';
import { api } from './api';
import { beginEarlyReads, clearEarlyReads } from './earlyReads';

afterEach(() => {
  clearEarlyReads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function heldBody(url = '/api/auth/session?summary=true') {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      if (_url !== url) return Promise.resolve(Response.json({ authenticated: true }));
      signal = init.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      });
      signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
      return Promise.resolve(
        new Response(stream, { headers: { 'content-type': 'application/json' } }),
      );
    }),
  );
  const target = Object.assign(new EventTarget(), {
    location: new URL('https://example.test/agents'),
  }) as unknown as Window;
  vi.stubGlobal('window', target);
  beginEarlyReads(target, [...RESERVED_HANDLES]);
  return {
    signal: () => signal,
    finish: () => {
      body.enqueue(new TextEncoder().encode('{"ok":true}'));
      body.close();
    },
  };
}

it.each(['session', 'self'])(
  'aborts an adopted %s body after headers when its consumer cancels',
  async (read) => {
    const body = heldBody(read === 'self' ? '/api/managed/self' : undefined);
    const scope = new AbortController();
    const result =
      read === 'self'
        ? sourceApi('/self', { base: '/api/managed', signal: scope.signal })
        : api('auth/session?summary=true', undefined, { signal: scope.signal });
    await new Promise((resolve) => setTimeout(resolve, 0)); // Headers have resolved; JSON is held.
    scope.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(body.signal().aborted).toBe(true);
  },
);

it('aborts an adopted body after headers when the API deadline expires', async () => {
  vi.useFakeTimers();
  const body = heldBody();
  const result = api('auth/session?summary=true', undefined, { timeout: 10 }).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ code: 'REQUEST_TIMEOUT' });
  expect(body.signal().aborted).toBe(true);
});

it('a cancelled source body must never resolve as an empty success', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      if (_url.includes('/auth/session'))
        return Promise.resolve(Response.json({ authenticated: true }));
      signal = init.signal as AbortSignal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
              signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
            },
          }),
        ),
      );
    }),
  );
  const target = Object.assign(new EventTarget(), {
    location: new URL('https://example.test/sample/repo'),
  }) as unknown as Window;
  vi.stubGlobal('window', target);
  beginEarlyReads(target, [...RESERVED_HANDLES]);
  const scope = new AbortController();
  const result = sourceApi('/resolve/sample/repo?summary=true&overview=true&ref=main', {
    signal: scope.signal,
  }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  scope.abort();
  // Erroring the body also exposes an adapter that swallows abort into successful {}.
  if (!signal.aborted) body.error(new DOMException('Read cancelled', 'AbortError'));
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(signal.aborted).toBe(true);
});

it('keeps the cancellation bridge through body consumption and releases it after success', async () => {
  const target = Object.assign(new EventTarget(), {
    location: new URL('https://example.test/sample/repo'),
  }) as unknown as Window;
  vi.stubGlobal('window', target);
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let transport!: AbortSignal;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      if (url.includes('/auth/session'))
        return Promise.resolve(Response.json({ authenticated: true }));
      transport = init.signal as AbortSignal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              body = c;
            },
          }),
        ),
      );
    }),
  );
  beginEarlyReads(target, [...RESERVED_HANDLES]);
  const scope = new AbortController();
  const removed = vi.spyOn(scope.signal, 'removeEventListener');
  const result = sourceApi('/resolve/sample/repo?summary=true&overview=true&ref=main', {
    signal: scope.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(removed).not.toHaveBeenCalled();
  body.enqueue(new TextEncoder().encode('{"ok":true}'));
  body.close();
  await expect(result).resolves.toEqual({ ok: true });
  expect(removed).toHaveBeenCalledTimes(1);
  scope.abort();
  expect(transport.aborted).toBe(false);
});
