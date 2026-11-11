import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});
async function setup(enabled = true) {
  vi.useFakeTimers();
  const send = vi.fn((_url: string, _body: Blob) => true);
  vi.stubGlobal('navigator', { sendBeacon: send });
  vi.stubGlobal('location', { pathname: '/admin/overview' });
  vi.stubGlobal('document', {
    querySelector: () => (enabled ? { getAttribute: () => 'on' } : null),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    run();
    return 1;
  });
  const client = await import('./clientPerformance');
  client.startClientPerformance();
  return { client, send };
}
it('stays inert without the server switch', async () => {
  const { client, send } = await setup(false);
  client.apiTiming(10, 200);
  client.contentReady();
  client.flushPerformance();
  expect(send).not.toHaveBeenCalled();
});
it('keeps old requests out of a later navigation and sends no resource paths', async () => {
  const { client, send } = await setup();
  const old = client.performanceNavigation();
  client.navigationStarted('/someone/private/files/secret.md');
  client.apiTiming(100, 500, 'request-123', undefined, old);
  client.apiTiming(20, 200, 'request-456');
  client.contentReady();
  client.contentReady();
  client.flushPerformance();
  expect(send).toHaveBeenCalledTimes(1);
  const body = JSON.parse(await (send.mock.calls[0][1] as Blob).text());
  expect(body.path).toBe('/:owner/:repo/files');
  expect(body.metrics.map((m: { name: string }) => m.name)).toEqual([
    'api_ms',
    'navigation_ready_ms',
  ]);
  expect(JSON.stringify(body)).not.toMatch(/someone|private|secret|request-123/);
});
it('bounds a noisy page to one ten-entry batch and does not retry a lost beacon', async () => {
  const { client, send } = await setup();
  send.mockReturnValue(false);
  for (let i = 0; i < 50; i++) client.apiTiming(10, 200);
  client.flushPerformance();
  client.flushPerformance();
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await (send.mock.calls[0][1] as Blob).text()).metrics).toHaveLength(10);
});
