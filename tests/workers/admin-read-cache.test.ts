import { expect, it, vi } from 'vitest';
import { AdminReadCache, memoizedAdminRead } from '../../cloudflare/worker/admin-read-cache';

it('expires snapshots and isolates keys and mutable answers', async () => {
  let now = 100; const cache = new AdminReadCache(() => now);
  const load = vi.fn(async () => ({ count: 1 }));
  const a = await cache.read('operator-a/traffic', load), b = await cache.read('operator-a/traffic', load);
  expect(load).toHaveBeenCalledTimes(1); a.count = 9; expect(b.count).toBe(1);
  expect(await cache.read('operator-a/traffic', load)).toEqual({ count: 1 });
  await cache.read('operator-b/traffic', load); expect(load).toHaveBeenCalledTimes(2);
  now += 15000; await cache.read('operator-a/traffic', load); expect(load).toHaveBeenCalledTimes(3);
});
it('does not cache failures or revive a read cleared during a mutation', async () => {
  const cache = new AdminReadCache(); const refused = vi.fn(async () => ({ ok: false }));
  await cache.read('x', refused); await cache.read('x', refused); expect(refused).toHaveBeenCalledTimes(2);
  let release!: (value: any) => void;
  const first = cache.read('late', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve(); cache.clear(); release({ count: 1 }); await first;
  const load = vi.fn(async () => ({ count: 2 })); expect(await cache.read('late', load)).toEqual({ count: 2 }); expect(load).toHaveBeenCalledTimes(1);
});

it('limits memoization to read-only lists and aggregate reports', () => {
  for (const section of ['accounts', 'repos', 'signups', 'audit', 'visitors', 'agents', 'operations', 'revenue']) expect(memoizedAdminRead(section)).toBe(true);
  for (const section of ['accounts', 'repos', 'billing', 'tokens', 'ssh-keys', 'infrastructure']) expect(memoizedAdminRead(section, 'detail')).toBe(false);
  expect(memoizedAdminRead('infrastructure')).toBe(false);
});
