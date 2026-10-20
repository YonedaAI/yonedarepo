// P4 change-log analytics: the post-land derive job streams change records to a Basin
// Pipeline binding (faked here). Events match the stream schema, carry no contents, are
// resumable and keyed for dedupe, and a failing pipeline never fails a landing or the job.
import { expect, it } from 'vitest';
import schema from '../../cloudflare/basin/change-log.schema.json';
import type { ChangeEvent } from '../../cloudflare/worker/repo-changelog';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Fake = { sent: ChangeEvent[][]; failing: boolean };
function pipeline(): { env: Env; fake: Fake } {
  const fake: Fake = { sent: [], failing: false };
  const CHANGELOG = {
    send: async (records: ChangeEvent[]) => {
      if (fake.failing) throw new Error('pipeline unavailable');
      fake.sent.push(records);
    },
  };
  return { env: { ...scoped, CHANGELOG } as unknown as Env, fake };
}

async function setup(name: string, env: Env) {
  const owner = { cookie: await signup(name) };
  const policy = { required_checks: [], approvals: 0 };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('secret-plan.txt', 'do not leak\n')], author } }, env);
  const id = created.body.id as string;
  const land = async (path: string) => {
    const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file(path, 'private body\n')], message: 'confidential message', author } }, env);
    const landed = await api(`/repos/${id}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, env);
    expect(landed.body.landed).toBe(true);
    return made.body.commit as string;
  };
  const derive = () => deriveAfterLanding(env, { v: 1, kind: 'platform_derive', repo_id: id, job_id: 'main' });
  return { owner, id, land, derive };
}

const kinds: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  int32: Number.isInteger,
  int64: Number.isInteger,
  timestamp: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.endsWith('Z'),
  list: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};

it('streams one schema-valid event per landed version, without contents', async () => {
  const { env, fake } = pipeline();
  const { id, land, derive } = await setup('analyst', env);
  const commit = await land('notes/a.txt');
  await derive();
  const events = fake.sent.flat();
  expect(events.map((e) => e.event_key)).toEqual([`${id}:v1`, `${id}:v2`]);
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  for (const event of events) {
    for (const [name, value] of Object.entries(event)) {
      expect(fields.has(name), name).toBe(true);
      expect(kinds[fields.get(name)!.type](value), `${name}=${value}`).toBe(true);
    }
    for (const field of schema.fields.filter((f) => f.required)) expect(event[field.name], field.name).toBeDefined();
  }
  expect(events[1]).toMatchObject({ event: 'land', repo: id, version: 2, ref: 'refs/heads/main', commit, kind: 'commit', paths_changed: 1, actor_kind: 'user', checks: [] });
  expect(events[1].land_latency_ms).toBeGreaterThanOrEqual(0);
  const text = JSON.stringify(events);
  for (const leaked of ['confidential', 'private body', 'notes/a.txt', 'secret-plan', 'do not leak']) expect(text).not.toContain(leaked);
});

it('resumes from its cursor and re-sends only with the same keys', async () => {
  const { env, fake } = pipeline();
  const { id, land, derive } = await setup('resumer', env);
  await land('a.txt');
  await derive();
  await derive(); // a duplicate queue delivery
  expect(fake.sent.flat()).toHaveLength(2);
  await land('b.txt');
  await derive();
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v1`, `${id}:v2`, `${id}:v3`]);
  // A lost cursor replays everything; the keys are stable, so consumers dedupe them.
  await bindings.OBJECTS.delete(`platform/v1/${id}/changelog/cursor.json`);
  await derive();
  const keys = fake.sent.flat().map((e) => e.event_key);
  expect(new Set(keys).size).toBe(3);
  expect(keys).toHaveLength(6);
});

it('lands and derives while the pipeline throws, counts the failure, then catches up', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land, derive } = await setup('outage', env);
  fake.failing = true;
  await land('a.txt'); // landing never touches the stream
  await expect(derive()).resolves.toMatchObject({ built: expect.any(Number) });
  const status = await api(`/repos/${id}/changelog`, owner, {}, env);
  expect(status.body).toMatchObject({ enabled: true, sent: 0, failures: 1, last_error: { code: 'CHANGELOG_SEND' } });
  expect(status.body.last_error.message).toBe('pipeline unavailable');
  fake.failing = false;
  await land('b.txt');
  await derive();
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v1`, `${id}:v2`, `${id}:v3`]);
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ sent: 3, failures: 1, version: 3 });
  // Without a bound stream the job skips emission entirely.
  expect((await api(`/repos/${id}/changelog`, owner, {}, scoped)).body.enabled).toBe(false);
});
