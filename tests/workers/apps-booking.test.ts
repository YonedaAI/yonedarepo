import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { sha } from '../../cloudflare/apps/bundle';
import type { AppBundle, TrustedApp } from '../../cloudflare/apps/contracts';
import type { AppRunner } from '../../cloudflare/apps/runner';

const bindings = env as unknown as {
  BOOKING_BUNDLE: string;
  OBJECTS: R2Bucket;
  APP_RUNNERS: DurableObjectNamespace<AppRunner>;
};
it('executes real booking JS modules and UI with isolated seeded SQLite through WorkerLoader', async () => {
  const bundle: AppBundle = JSON.parse(bindings.BOOKING_BUNDLE);
  const digest = await sha(bindings.BOOKING_BUNDLE);
  await bindings.OBJECTS.put(`sha256/${digest}`, bindings.BOOKING_BUNDLE, {
    onlyIf: { etagDoesNotMatch: '*' },
  });
  const app: TrustedApp = {
    app_id: 'booking',
    revision: bundle.revision,
    policy_digest: bundle.policy_digest,
    bundle_digest: digest,
    mode: 'preview',
    generation: 1,
  };
  const runner = bindings.APP_RUNNERS.getByName('preview:booking:first');
  const req = (path: string, body?: unknown) =>
    new Request(
      `https://app.invalid${path}`,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    );
  const ui = await runner.serve(app, req('/'));
  expect(ui.status).toBe(200);
  expect(ui.headers.get('content-type')).toContain('text/html');
  expect(await ui.text()).toContain('/app.mjs');
  const js = await runner.serve(app, req('/app.mjs'));
  expect(js.status).toBe(200);
  const created = await runner.serve(
    app,
    req('/api/events/workshop/registrations', {
      name: 'Ada',
      email: 'ada@example.com',
      idempotency_key: 'booking-one',
    }),
  );
  expect(created.status).toBe(201);
  const value = await created.json<{ registration: { id: number; status: string } }>();
  expect(value.registration.status).toBe('confirmed');
  const read = await runner.serve(app, req(`/api/registrations/${value.registration.id}`));
  expect(read.status).toBe(200);
  const events = await runner.serve(app, req('/api/events'));
  const data = await events.json<{ events: { id: string; confirmed: number }[] }>();
  expect(data.events.find((e) => e.id === 'workshop')?.confirmed).toBe(1);
  const isolated = await bindings.APP_RUNNERS.getByName('preview:booking:second').serve(
    app,
    req('/api/events'),
  );
  expect(
    (await isolated.json<{ events: { id: string; confirmed: number }[] }>()).events.find(
      (e) => e.id === 'workshop',
    )?.confirmed,
  ).toBe(0);
});
