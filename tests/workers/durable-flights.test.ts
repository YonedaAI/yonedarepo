import { env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { DurableFlightsFixture } from './durable-flights-fixture';

it('DO-owned work survives its initiating HTTP cancellation and a fresh request joins it', async () => {
  const ns = (env as unknown as { DURABLE_FLIGHTS: DurableObjectNamespace<DurableFlightsFixture> }).DURABLE_FLIGHTS;
  const stub = ns.get(ns.newUniqueId());
  const cancelled = new AbortController();
  const first = stub.fetch('https://flights/read', { signal: cancelled.signal }).catch((e: Error) => e.name);
  const stats = async () => (await stub.fetch('https://flights/stats')).json<{calls: number; joined: number}>();
  try {
    await vi.waitFor(async () => expect((await stats()).calls).toBe(1));
    cancelled.abort();
    expect(await first).toBe('AbortError');
    const second = stub.fetch('https://flights/read');
    await vi.waitFor(async () => expect(await stats()).toEqual({calls: 1, joined: 1}));
    await stub.fetch('https://flights/release');
    expect(await (await second).text()).toBe('ready');
    expect(await stats()).toEqual({calls: 1, joined: 1});
  } finally {
    await stub.fetch('https://flights/release');
  }
});
