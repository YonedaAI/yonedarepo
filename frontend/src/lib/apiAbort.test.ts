import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('obsolete repository read cancellation', () => {
  it('settles and aborts an obsolete GET even when the transport ignores cancellation', async () => {
    let transportSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path, options) => {
        transportSignal = options.signal;
        return new Promise(() => {});
      }),
    );
    const scope = new AbortController();
    const pending = api('repos/old/overview', undefined, { signal: scope.signal });
    scope.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(true);
  });

  it('does not send an already obsolete GET', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const scope = new AbortController();
    scope.abort();
    await expect(
      api('repos/old/overview', undefined, { signal: scope.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not cancel or replay a mutation when a repository read scope ends', async () => {
    const scope = new AbortController();
    let resolve!: (value: Response) => void;
    let transportSignal: AbortSignal | undefined;
    const fetch = vi.fn((_path, options) => {
      transportSignal = options.signal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    vi.stubGlobal('fetch', fetch);
    const pending = api('repos/old/start_run', { id: 'same-request' }, { signal: scope.signal });
    scope.abort();
    expect(transportSignal?.aborted).toBe(false);
    resolve(new Response(JSON.stringify({ id: 'same-request' })));
    await expect(pending).resolves.toEqual({ id: 'same-request' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('bodyless DELETE finishes once after its read scope is canceled', async () => {
  const scope = new AbortController();
  let finish!: (value: Response) => void;
  let signal!: AbortSignal;
  const send = vi.fn((_path, options) => {
    signal = options.signal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  vi.stubGlobal('fetch', send);
  const pending = api('auth/notifications/acme%3A1', undefined, {
    method: 'DELETE',
    signal: scope.signal,
  }).catch((error) => error);
  scope.abort();
  expect(signal.aborted).toBe(false);
  finish(Response.json({ items: [], unread: 0 }));
  await expect(pending).resolves.toEqual({ items: [], unread: 0 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[1].method).toBe('DELETE');
});
