import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { earlyReads } from '../../frontend/vite-early-reads';

function tags(enabled: boolean) {
  const plugin = earlyReads(enabled);
  const hook = plugin.transformIndexHtml as { handler: () => { tag: string; children: string; injectTo: string }[] };
  return hook.handler();
}

it('the disabled build has no early request script', () => expect(tags(false)).toEqual([]));

it('the bounded head script executes alone before React or application modules', () => {
  const [tag] = tags(true);
  if (!tag) throw new Error('Expected startup script');
  expect(tag?.tag).toBe('script');
  expect(tag?.injectTo).toBe('head-prepend');
  expect(Buffer.byteLength(tag.children)).toBeLessThan(4096);
  const fetch = vi.fn((_url: string) => new Promise(() => {}));
  const target = Object.assign(new EventTarget(), {
    location: { pathname: '/sample/repo', search: '', hash: '' },
  });
  new Script(tag.children).runInNewContext({
    window: target, fetch, AbortController, DOMException,
    setTimeout: () => 1, clearTimeout: () => {},
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockClear();
  target.location.pathname = '/agents';
  Object.defineProperty(target, 'localStorage', { get() { throw new Error('Blocked'); } });
  new Script(tag.children).runInNewContext({
    window: target, fetch, AbortController, DOMException,
    setTimeout: () => 1, clearTimeout: () => {},
  });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    '/api/auth/session?summary=true', '/api/managed/self',
  ]);
});
