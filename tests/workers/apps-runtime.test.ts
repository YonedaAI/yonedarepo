import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { AppRunner } from '../../cloudflare/apps/runner';
import { install, manifest } from './apps-test-fixture';

const bindings = env as unknown as {
  OBJECTS: R2Bucket;
  APP_RUNNERS: DurableObjectNamespace<AppRunner>;
};

const stub = (id: string) => bindings.APP_RUNNERS.getByName(id);
const request = (value?: string) =>
  new Request('https://app.invalid/api/notes', value ? { method: 'POST', body: value } : {});
it('isolated app API SQL persists with seed and no cross-app data', async () => {
  const a = await install('a');
  const b = await install('b');
  expect(await (await stub('a').serve(a, request('private'))).json()).toEqual({
    tag: 'v1',
    values: ['seed', 'private'],
  });
  expect(await (await stub('a').serve(a, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed', 'private'],
  });
  expect(await (await stub('b').serve(b, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed'],
  });
});
it('pins candidate revision and isolates candidates from stable published appDB', async () => {
  const old = await install('pin');
  const next = await install('pin', 'preview', 1, 'v2');
  await stub('pin').serve(old, request('old'));
  expect(await (await stub('pin').serve(next, request())).json()).toEqual({
    tag: 'v2',
    values: ['seed'],
  });
  expect(await (await stub('pin').serve(old, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed', 'old'],
  });
  const published = await install('pin', 'published');
  expect(await (await stub('pin').serve(published, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed'],
  });
});
it('blocks network and exposes no platform env bindings', async () => {
  const a = await install('net');
  expect(
    await (await stub('net').serve(a, new Request('https://app.invalid/outbound'))).json(),
  ).toEqual({ denied: true, env: [] });
});
it('upgrades published code with abort/get retaining storage and rejects stale publication', async () => {
  const old = await install('upgrade', 'published');
  await stub('upgrade').serve(old, request('retained'));
  const profile = {
    ...manifest,
    migrations: [
      ...manifest.migrations,
      { version: 2, sql: ['ALTER TABLE notes ADD COLUMN extra TEXT'] },
    ],
  };
  const next = await install('upgrade', 'published', 2, 'v2', profile);
  expect(await (await stub('upgrade').serve(next, request())).json()).toEqual({
    tag: 'v2',
    values: ['seed', 'retained'],
  });
  expect((await stub('upgrade').serve(old, request())).status).toBe(503);
});
it('rejects changed migration history, destructive schema and authority digest mismatches', async () => {
  const old = await install('invalid', 'published');
  await stub('invalid').serve(old, request('retained'));
  const changed = await install('invalid', 'published', 2, 'v2', {
    ...manifest,
    migrations: [{ version: 1, sql: ['CREATE TABLE other (id TEXT)'] }],
  });
  expect((await stub('invalid').serve(changed, request())).status).toBe(503);
  const bad = await install('bad', 'preview', 1, 'v2', {
    ...manifest,
    migrations: [{ version: 1, sql: ['DROP TABLE notes'] }],
  });
  expect((await stub('bad').serve(bad, request())).status).toBe(503);
  expect(
    (await stub('invalid').serve({ ...old, revision: 'd'.repeat(40) }, request())).status,
  ).toBe(503);
  expect(
    (await stub('invalid').serve({ ...old, policy_digest: 'd'.repeat(64) }, request())).status,
  ).toBe(503);
});
it('accepts equivalent migration records independent of JSON property order', async () => {
  const first = await install('ordered', 'published');
  await stub('ordered').serve(first, request('keep'));
  const profile = {
    ...manifest,
    migrations: [
      { sql: manifest.migrations[0].sql, version: 1 },
      { sql: ['CREATE INDEX notes_value ON notes(value)'], version: 2 },
    ],
  };
  const next = await install('ordered', 'published', 2, 'v2', profile);
  expect((await stub('ordered').serve(next, request())).status).toBe(200);
});

it('facet restart reapplies no migration or seed and retains published storage', async () => {
  const app = await install('restart', 'published');
  await stub('restart').serve(app, request('persisted'));
  await runInDurableObject(stub('restart'), async (_instance, state) => {
    state.facets.abort('appDB', new Error('Test restart'));
  });
  expect(await (await stub('restart').serve(app, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed', 'persisted'],
  });
});
it('fails closed on corrupt R2 bytes, foreign authority and direct HTTP DO access', async () => {
  const app = await install('sealed');
  await stub('sealed').serve(app, request('secret'));
  expect((await stub('sealed').serve({ ...app, app_id: 'foreign' }, request())).status).toBe(503);
  expect((await stub('sealed').fetch('https://app.invalid/')).status).toBe(404);
  await bindings.OBJECTS.put(`sha256/${app.bundle_digest}`, 'corrupt bytes');
  expect((await stub('sealed').serve(app, request())).status).toBe(503);
});
it('rolls back a failed additive migration and continues serving the previous published revision', async () => {
  const old = await install('rollback', 'published');
  await stub('rollback').serve(old, request('retained'));
  const broken = await install('rollback', 'published', 2, 'v2', {
    ...manifest,
    migrations: [
      ...manifest.migrations,
      {
        version: 2,
        sql: [
          'ALTER TABLE notes ADD COLUMN extra TEXT',
          'CREATE INDEX missing_idx ON missing_table(value)',
        ],
      },
    ],
  });
  expect((await stub('rollback').serve(broken, request())).status).toBe(503);
  expect(await (await stub('rollback').serve(old, request())).json()).toEqual({
    tag: 'v1',
    values: ['seed', 'retained'],
  });
  const fixed = await install('rollback', 'published', 2, 'v2', {
    ...manifest,
    migrations: [
      ...manifest.migrations,
      { version: 2, sql: ['ALTER TABLE notes ADD COLUMN extra TEXT'] },
    ],
  });
  expect((await stub('rollback').serve(fixed, request())).status).toBe(200);
});
