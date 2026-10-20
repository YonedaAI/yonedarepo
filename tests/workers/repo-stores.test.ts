// Content-addressed writes: concurrent commits write the same object ids, and R2 allows one
// write per key at a time (error 10058). A shared write is joined, and a 10058 on an object
// that is (or becomes) readable is success, never a failed commit.
import { expect, it } from 'vitest';
import { putObjects } from '../../cloudflare/worker/repo-stores';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from './repo-fixture';

const busy = () => new Error('put: Reduce your concurrent request rate for the same object. (10058)');
function r2(rule: (key: string, attempt: number) => 'ok' | 'busy' | 'busy-written') {
  const puts = new Map<string, number>();
  const stored = new Set<string>();
  const bucket = {
    async put(key: string) {
      const attempt = (puts.get(key) ?? 0) + 1;
      puts.set(key, attempt);
      await new Promise((r) => setTimeout(r, 5));
      const outcome = rule(key, attempt);
      if (outcome === 'busy-written') stored.add(key);
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
