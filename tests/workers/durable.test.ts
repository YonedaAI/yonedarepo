// A Durable Object reset (deploy, eviction) mid-call is retried once on a fresh stub;
// other failures are not.
import { expect, it } from 'vitest';
import { durableJson, failureCode, transient } from '../../cloudflare/worker/durable';

const stubs = (failures: unknown[]) => {
  let made = 0;
  return {
    get made() {
      return made;
    },
    stub: () => {
      made++;
      return {
        fetch: async () => {
          const failure = failures.shift();
          if (failure) throw failure;
          return Response.json({ ok: true });
        },
      } as unknown as DurableObjectStub;
    },
  };
};

it('retries a reset instance once on a fresh stub', async () => {
  const reset = Object.assign(new Error('Connection closed: this Durable Object instance is no longer active.'), {});
  const s = stubs([reset]);
  expect(await durableJson(s.stub, 'https://x/', '{}')).toEqual({ ok: true });
  expect(s.made).toBe(2);
});

it('does not retry other failures, or a second reset', async () => {
  const s = stubs([new Error('boom')]);
  await expect(durableJson(s.stub, 'https://x/', '{}')).rejects.toThrow('boom');
  const twice = stubs([Object.assign(new Error('x'), { retryable: true }), Object.assign(new Error('y'), { retryable: true })]);
  await expect(durableJson(twice.stub, 'https://x/', '{}')).rejects.toThrow('y');
});

// Measured: production says the first when a write passes the limit, workerd the second; both
// arrive thrown, with the instance reset, however the Durable Object handled the statement.
it.each(['Exceeded the maximum database size.', 'database or disk is full: SQLITE_FULL'])('names a full database, without retrying or calling it transient: %s', async (message) => {
  const s = stubs([Object.assign(new Error(message), { retryable: true, durableObjectReset: true })]);
  const failure = await durableJson(s.stub, 'https://x/', '{}').catch((e) => e);
  expect(s.made).toBe(1);
  expect(failure.code).toBe('REPO_FULL');
  expect(failureCode(failure)).toBe('REPO_FULL');
  expect(transient(failure)).toBe(false);
});
