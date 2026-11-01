// A queue batch that is cancelled never settles its work. No later batch may wait on it: Workers
// drops a continuation whose request has ended, so a chain shared across invocations hangs every
// heavy job after the first cancelled one, and each hung batch ends in an exception with no log.
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import type { Env, Envelope } from '../../cloudflare/worker/types';

const message = (body: Envelope) => {
  const seen = { acked: false, retried: false };
  return { seen, message: { body, attempts: 1, ack: () => (seen.acked = true), retry: () => (seen.retried = true) } };
};
const job = { v: 1, kind: 'platform_objects', repo_id: 'r00000000000000000000', job_id: 'shard:0' } as unknown as Envelope;

it('a heavy job does not wait for one a cancelled batch left unfinished', async () => {
  // Every Durable Object answers nothing, as the stub of a cancelled request does.
  const never = new Proxy({}, { get: () => () => new Promise(() => {}) });
  const hanging = new Proxy(env as unknown as Env, {
    get: (target, name) => {
      const value = Reflect.get(target, name) as { idFromName?: unknown };
      if (typeof value?.idFromName !== 'function') return value;
      return { idFromName: () => 'x', idFromString: () => 'x', get: () => never, getByName: () => never };
    },
  });
  void platformJob(hanging, message(job).message as unknown as Message<Envelope>).catch(() => {});
  const next = message(job);
  const settled = await Promise.race([
    platformJob(env as unknown as Env, next.message as unknown as Message<Envelope>).then(
      () => 'finished',
      () => 'finished',
    ),
    new Promise((done) => setTimeout(() => done('stuck behind the first'), 2_000)),
  ]);
  expect(settled).toBe('finished');
});
