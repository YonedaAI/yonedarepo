import { afterEach, expect, it, vi } from 'vitest';
import { RESERVED_HANDLES } from '../../../shared/account';
import { namedOverviewRef } from '../features/source-platform/overviewBootstrap';
import { resolvePath } from '../features/source-platform/RepoByName';
import { sourceApi } from '../features/source-platform/sourceApi';
import { parseSourceRoute } from '../features/source-platform/sourceRoute';
import { api } from './api';
import {
  clearEarlyReads,
  beginEarlyReads as installEarlyReads,
  takeEarlyResponse,
} from './earlyReads';

const beginEarlyReads = (target: Window) => installEarlyReads(target, [...RESERVED_HANDLES]);

afterEach(() => {
  clearEarlyReads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function windowAt(path = '/sample/MiMo-Code') {
  const url = new URL(path, 'https://example.test');
  const target = Object.assign(new EventTarget(), { location: url }) as unknown as Window;
  vi.stubGlobal('window', target);
  return target;
}

it('starts session and exact named Overview admission before the application runs', () => {
  const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const target = windowAt();
  beginEarlyReads(target);
  expect(fetch.mock.calls.map((args) => args[0])).toEqual([
    '/api/auth/session?summary=true',
    '/api/v1/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main',
  ]);
});

it('hands each response once to the normal API parser without another request', async () => {
  const fetch = vi.fn(async () => Response.json({ authenticated: true, username: 'sample' }));
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  await expect(api('auth/session?summary=true')).resolves.toMatchObject({ username: 'sample' });
  await expect(
    sourceApi('/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main'),
  ).resolves.toMatchObject({ username: 'sample' });
  expect(fetch).toHaveBeenCalledTimes(2);
  await api('auth/session?summary=true');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('retains a failed admission as the answer and never sends an uncounted duplicate', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: { code: 'FORBIDDEN', message: 'Not allowed' } }, { status: 403 }),
  );
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  await expect(api('auth/session?summary=true')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    sourceApi('/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main'),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('counts an early network failure as the first attempt instead of silently replaying it', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('network unavailable');
  });
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  await expect(api('auth/session?summary=true')).rejects.toThrow('network unavailable');
  await expect(
    sourceApi('/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main', { once: true }),
  ).rejects.toMatchObject({ code: 'NETWORK' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps the existing four-attempt read budget when the adopted response is a server fault', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () =>
    Response.json({ error: { code: 'UNAVAILABLE' } }, { status: 503 }),
  );
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  const result = sourceApi('/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main').catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(5); // One session and four resolver attempts in total.
});

it('settles consumer cancellation even if an early transport ignores abort', async () => {
  const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  const scope = new AbortController();
  const pending = sourceApi('/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main', {
    signal: scope.signal,
  });
  scope.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
});

it('does not cancel an adopted session when the resolver finishes navigation first', async () => {
  let done!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          done = resolve;
        }),
    ),
  );
  beginEarlyReads(windowAt('/agents'));
  const session = api('auth/session?summary=true');
  clearEarlyReads();
  done(Response.json({ authenticated: true, username: 'sample' }));
  await expect(session).resolves.toMatchObject({ username: 'sample' });
});

it.each(['changed-url', 'pagehide', 'clear', 'expired'])('never donates after %s', async (mode) => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => Response.json({ early: true }));
  vi.stubGlobal('fetch', fetch);
  const target = windowAt();
  beginEarlyReads(target);
  if (mode === 'changed-url') target.location.pathname = '/sample/another';
  if (mode === 'pagehide') target.dispatchEvent(new Event('pagehide'));
  if (mode === 'clear') clearEarlyReads();
  if (mode === 'expired') await vi.advanceTimersByTimeAsync(30_001);
  expect(takeEarlyResponse('/api/auth/session?summary=true')).toBeUndefined();
  expect(
    takeEarlyResponse('/api/v1/resolve/sample/MiMo-Code?summary=true&overview=true&ref=main'),
  ).toBeUndefined();
});

it('invalidates unconsumed reads before auth or platform mutations', async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt());
  await api('auth/logout', {});
  expect(takeEarlyResponse('/api/auth/session?summary=true')).toBeUndefined();
  beginEarlyReads(windowAt());
  await sourceApi('/repos/example', { method: 'DELETE' });
  expect(takeEarlyResponse('/api/auth/session?summary=true')).toBeUndefined();
  beginEarlyReads(windowAt());
  await api('auth/session?summary=true', undefined, { method: 'PUT' });
  expect(takeEarlyResponse('/api/auth/session?summary=true')).toBeUndefined();
});

it('uses no response for a different ref or version floor', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  );
  beginEarlyReads(windowAt());
  for (const suffix of ['ref=other', 'ref=main&min_version=7'])
    expect(
      takeEarlyResponse(`/api/v1/resolve/sample/MiMo-Code?summary=true&overview=true&${suffix}`),
    ).toBeUndefined();
});

it.each([
  '/docs/reference',
  '/features/flight',
  '/source/r01234567890123456789',
  '/sample/repo/files',
  '/sample/repo?at=7',
  '/sample/repo?ref=main',
  '/sample/repo?anything=1',
  '/sample/repo#old',
  '/bad-handle/repo',
])('does not speculate on unsupported or reserved route %s', (path) => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  beginEarlyReads(windowAt(path));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['/sample/repo', '/sample/MiMo-Code', '/sample/name_1/'])(
  'matches the authoritative resolver contract for %s',
  (path) => {
    const fetch = vi.fn((_url: string) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    beginEarlyReads(windowAt(path));
    const route = parseSourceRoute(path, '');
    expect(route.view).toBe('repo-name');
    if (route.view === 'repo-name')
      expect(fetch.mock.calls[1]?.[0]).toBe(
        `/api/v1${resolvePath(route.owner, route.name, namedOverviewRef(route))}`,
      );
  },
);

it('excludes every generated reserved handle, including operator and Worker routes', () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  for (const handle of RESERVED_HANDLES) {
    fetch.mockClear();
    beginEarlyReads(windowAt(`/${handle}/example`));
    expect(fetch, handle).toHaveBeenCalledTimes(1);
    clearEarlyReads();
  }
});
