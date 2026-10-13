import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('actual WorkerLoader + SQLite facet persists and denies global outbound', async () => {
  const stub = (env as unknown as { CANARY: DurableObjectNamespace }).CANARY.getByName('counter');
  expect(await (await stub.fetch('https://app.invalid/')).json()).toEqual({ n: 1, denied: true });
  expect(await (await stub.fetch('https://app.invalid/')).json()).toEqual({ n: 2, denied: true });
});
