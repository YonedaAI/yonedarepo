// Content-addressed writes: concurrent commits write the same object ids, and R2 allows one
// write per key at a time (error 10058). A shared write is joined, and a 10058 on an object
// that is (or becomes) readable is success, never a failed commit. R2's transient internal
// error (10001) and service-unavailable (10043) are retried.
import { expect, it } from 'vitest';
import { putObjects } from '../../cloudflare/worker/repo-stores';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from './repo-fixture';

const busy = () => new Error('put: Reduce your concurrent request rate for the same object. (10058)');
const internal = () => new Error('put: We encountered an internal error. Please try again. (10001)');
const unavailable = () =>
  new Error('put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)');
function r2(rule: (key: string, attempt: number) => 'ok' | 'busy' | 'busy-written' | 'internal' | 'unavailable') {
  const puts = new Map<string, number>();
  const stored = new Set<string>();
  const bucket = {
    async put(key: string) {
      const attempt = (puts.get(key) ?? 0) + 1;
      puts.set(key, attempt);
      await new Promise((r) => setTimeout(r, 5));
      const outcome = rule(key, attempt);
      if (outcome === 'busy-written') stored.add(key);
      if (outcome === 'internal') throw internal();
      if (outcome === 'unavailable') throw unavailable();
      if (outcome !== 'ok') throw busy();
      stored.add(key);
    },
    async head(key: string) {
      return stored.has(key) ? { key } : null;
    },
  };
  return { env: { ...bindings, OBJECTS: bucket } as unknown as Env, puts, stored };
}
const blob = (id: string) => ({ id, kind: 'blob' as const, data_b64: btoa(id) });
const key = (prefix: string) => (id: string) => `${prefix}/${id}`;

it('joins concurrent writes of one object and skips objects already written', async () => {
  const { env, puts } = r2(() => 'ok');
  const k = key(`join-${crypto.randomUUID()}`);
  await Promise.all(Array.from({ length: 20 }, () => putObjects(env, k, [blob('a'.repeat(40))])));
  await putObjects(env, k, [blob('a'.repeat(40))]);
  expect([...puts.values()]).toEqual([1]);
});

it('treats 10058 on a readable object as written and retries an unreadable one', async () => {
  const { env, stored } = r2((k, attempt) => (k.endsWith('b'.repeat(40)) ? 'busy-written' : attempt === 1 ? 'busy' : 'ok'));
  const k = key(`busy-${crypto.randomUUID()}`);
  await putObjects(env, k, [blob('b'.repeat(40)), blob('c'.repeat(40))]);
  expect(stored.has(k('b'.repeat(40)))).toBe(true);
  expect(stored.has(k('c'.repeat(40)))).toBe(true);
});

it('still fails when the object never becomes readable', async () => {
  const { env } = r2(() => 'busy');
  await expect(putObjects(env, key(`fail-${crypto.randomUUID()}`), [blob('d'.repeat(40))])).rejects.toThrow('10058');
});

it('retries an internal error and gives up after three retries', async () => {
  const { env, stored } = r2((_, attempt) => (attempt <= 2 ? 'internal' : 'ok'));
  const k = key(`internal-${crypto.randomUUID()}`);
  await putObjects(env, k, [blob('e'.repeat(40))]);
  expect(stored.has(k('e'.repeat(40)))).toBe(true);
  const { env: down } = r2(() => 'internal');
  await expect(putObjects(down, key(`down-${crypto.randomUUID()}`), [blob('f'.repeat(40))])).rejects.toThrow('10001');
});

it('retries service unavailable (10043)', async () => {
  const { env, stored } = r2((_, attempt) => (attempt === 1 ? 'unavailable' : 'ok'));
  const k = key(`unavailable-${crypto.randomUUID()}`);
  await putObjects(env, k, [blob('9'.repeat(40))]);
  expect(stored.has(k('9'.repeat(40)))).toBe(true);
});
