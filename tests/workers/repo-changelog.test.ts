// P4 change-log analytics: the post-land derive job streams change records to a Basin
// Pipeline binding (faked here). Events match the stream schema, carry no contents, are
// resumable and keyed for dedupe, and a failing pipeline never fails a landing or the job.
// A stream starts at the head, and one that stops never stops the repository's compaction.
import { expect, it, vi } from 'vitest';
import schema from '../../cloudflare/basin/change-log.schema.json';
import { type ChangeEvent, changeLogHold, emitChangeLog, sendBatches, skipChangeLog } from '../../cloudflare/worker/repo-changelog';
import { compactLog } from '../../cloudflare/worker/repo-compaction';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { caller } from '../../cloudflare/worker/repo-ops';
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

/** The repository's stream position, starting it at the head unless told not to. */
async function setup(name: string, env: Env, { started = true } = {}) {
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
  if (started) await emitChangeLog(env, id);
  return { owner, id, land, derive };
}

const cursorKey = (id: string) => `platform/v1/${id}/changelog/cursor.json`;
const cursorOf = async (id: string) => (await (await bindings.OBJECTS.get(cursorKey(id)))!.json<any>());
const compact = (env: Env, id: string) => compactLog(env, id, caller(env, id, { _system: 'compact' }));

/** Moves 100 branches back and forth until the log reaches `head`, keeping 64 versions. */
async function grow(owner: { cookie: string }, id: string, head: number) {
  const repo = `/repos/${id}`;
  await api(`${repo}/retention`, owner, { method: 'PUT', body: { keep_versions: 64 } });
  const root = (await api(`${repo}/refs/main`, owner)).body.commit as string;
  const child = (await api(`${repo}/commits`, owner, { body: { parent: root, changes: [file('grown.txt', 'g\n')], message: 'g', author } })).body.commit as string;
  const at: (string | null)[] = Array(100).fill(null);
  let version = (await api(repo, owner)).body.version as number;
  while (version < head) {
    const updates = at.map((was, i) => {
      at[i] = was === root ? child : root;
      return { ref: `b${i}`, commit: at[i], expected: was };
    });
    const moved = await api(`${repo}/refs/batch`, owner, { body: { updates } });
    expect(moved.status).toBe(200);
    version = moved.body.version;
  }
  return version;
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
  expect(events.map((e) => e.event_key)).toEqual([`${id}:v2`]);
  const fields = new Map(schema.fields.map((f) => [f.name, f]));
  for (const event of events) {
    for (const [name, value] of Object.entries(event)) {
      expect(fields.has(name), name).toBe(true);
      expect(kinds[fields.get(name)!.type](value), `${name}=${value}`).toBe(true);
    }
    for (const field of schema.fields.filter((f) => f.required)) expect(event[field.name], field.name).toBeDefined();
  }
  expect(events[0]).toMatchObject({ event: 'land', repo: id, version: 2, ref: 'refs/heads/main', commit, kind: 'changeset', paths_changed: 1, actor_kind: 'user', checks: [] });
  expect(events[0].land_latency_ms).toBeGreaterThanOrEqual(0);
  const text = JSON.stringify(events);
  for (const leaked of ['confidential', 'private body', 'notes/a.txt', 'secret-plan', 'do not leak']) expect(text).not.toContain(leaked);
});

it('resumes from its cursor and re-sends only with the same keys', async () => {
  const { env, fake } = pipeline();
  const { id, land, derive } = await setup('resumer', env);
  await land('a.txt');
  await derive();
  await derive(); // a duplicate queue delivery
  expect(fake.sent.flat()).toHaveLength(1);
  await land('b.txt');
  await derive();
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v2`, `${id}:v3`]);
  // A rewound cursor replays its range; the keys are stable, so consumers dedupe them.
  await bindings.OBJECTS.put(cursorKey(id), JSON.stringify({ ...(await cursorOf(id)), version: 1 }));
  await derive();
  const keys = fake.sent.flat().map((e) => e.event_key);
  expect(new Set(keys).size).toBe(2);
  expect(keys).toHaveLength(4);
  // A lost cursor starts again at the head, with a gap and no replay.
  await bindings.OBJECTS.delete(cursorKey(id));
  await derive();
  expect(fake.sent.flat()).toHaveLength(4);
  expect((await cursorOf(id)).version).toBe(3);
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
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v2`, `${id}:v3`]);
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ sent: 2, failures: 1, version: 3 });
  // Without a bound stream the job skips emission entirely.
  expect((await api(`/repos/${id}/changelog`, owner, {}, scoped)).body.enabled).toBe(false);
});

it('sends each event once when two derive jobs for one repository race', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land, derive } = await setup('racer', env);
  await land('a.txt');
  await land('b.txt');
  await Promise.all([derive(), derive(), derive()]);
  expect(fake.sent.flat().map((e) => e.event_key).sort()).toEqual([`${id}:v2`, `${id}:v3`]);
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ version: 3, sent: 2, failures: 0 });
});

it('returns a claimed range when its send fails, so a later job re-sends it', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land, derive } = await setup('rollback', env);
  await land('a.txt');
  fake.failing = true;
  await derive();
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ version: 1, sent: 0, failures: 1 });
  fake.failing = false;
  await derive();
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v2`]);
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ version: 2, sent: 1, failures: 1 });
});

it('holds log compaction at a claimed range until it is sent or given back', async () => {
  let release!: (ok: boolean) => void;
  let sending!: () => void;
  const started = new Promise<void>((r) => {
    sending = r;
  });
  const gate = new Promise<boolean>((r) => {
    release = r;
  });
  const CHANGELOG = {
    send: async () => {
      sending();
      if (!(await gate)) throw new Error('pipeline unavailable');
    },
  };
  const env = { ...scoped, CHANGELOG } as unknown as Env;
  const { id, land } = await setup('claimer', env);
  await land('a.txt');

  // While version 2 is claimed but unsent, the cursor is past it, the hold is not.
  const emitting = emitChangeLog(env, id);
  await started;
  expect((await cursorOf(id)).version).toBe(2);
  expect(await changeLogHold(env, id)).toBe(1);
  // A failed send gives the range back: the cursor returns to it and nothing was compacted past it.
  release(false);
  expect((await emitting)?.version).toBe(1);
  expect(await changeLogHold(env, id)).toBe(1);
  expect((await cursorOf(id)).claims).toEqual({});
});

it('releases its claim once the range is sent', async () => {
  const { env, fake } = pipeline();
  const { id, land, derive } = await setup('releaser', env);
  await land('a.txt');
  await derive();
  expect(fake.sent.flat()).toHaveLength(1);
  expect(await changeLogHold(env, id)).toBe(2);
  // A claim left by a job that died expires after its lease and stops holding.
  const key = cursorKey(id);
  const state = await cursorOf(id);
  await bindings.OBJECTS.put(key, JSON.stringify({ ...state, claims: { 1: Date.now() - 11 * 60_000 } }));
  expect(await changeLogHold(env, id)).toBe(2);
  await bindings.OBJECTS.put(key, JSON.stringify({ ...state, claims: { 1: Date.now() } }));
  expect(await changeLogHold(env, id)).toBe(1);
});

it('starts a repository with no cursor at its head, and holds nothing before that', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land, derive } = await setup('binder', env, { started: false });
  await land('a.txt');
  // Bound over a repository with history: nothing to stream from 0, nothing to keep for it.
  expect(await changeLogHold(env, id)).toBeUndefined();
  await derive();
  expect(fake.sent.flat()).toEqual([]);
  expect((await cursorOf(id)).version).toBe(2);
  expect(await changeLogHold(env, id)).toBe(2);
  await land('b.txt');
  await derive();
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v3`]);
  expect((await api(`/repos/${id}/changelog`, owner, {}, env)).body).toMatchObject({ version: 3, sent: 1, failures: 0 });
});

it('leaves no cursor when a first job fails, so nothing is held at version 0', async () => {
  const { env } = pipeline();
  const { id } = await setup('firstfail', env, { started: false });
  const down = { ...env, SOURCE_REPOS: { idFromName: () => { throw new Error('authority unavailable'); } } } as unknown as Env;
  await expect(emitChangeLog(down, id)).resolves.toMatchObject({ version: 0 });
  expect(await bindings.OBJECTS.head(cursorKey(id))).toBeNull();
  expect(await changeLogHold(env, id)).toBeUndefined();
});

it('compacts with the stream stopped once it has failed too long, then skips past the gap', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land } = await setup('stopped', env);
  fake.failing = true;
  const head = await grow(owner, id, 1_100);
  await emitChangeLog(env, id);
  const stalled = await cursorOf(id);
  expect(stalled).toMatchObject({ version: 1, failures: 1, stalled_since: expect.any(Number) });

  // A failure just now still holds: the stream may come back and lose nothing.
  expect(await compact(env, id)).toMatchObject({ segments: 0, floor: 0 });
  await bindings.OBJECTS.put(cursorKey(id), JSON.stringify({ ...stalled, stalled_since: Date.now() - 8 * 86_400_000 }));
  expect(await compact(env, id)).toMatchObject({ segments: 1, floor: 1_024 });

  // The next job gives up the versions and logs it; the stream continues from the head.
  fake.failing = false;
  await emitChangeLog(env, id);
  expect(await cursorOf(id)).toMatchObject({ version: head, gaps: 1, last_gap: { from: 1, to: head, reason: 'age' }, claims: {} });
  expect((await cursorOf(id)).stalled_since).toBeUndefined();
  await land('after.txt');
  await emitChangeLog(env, id);
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v${head + 1}`]);
  expect(await changeLogHold(env, id)).toBe(head + 1);
});

it('raises the alarm only once a hold has stalled compaction', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stalls = () => logged.mock.calls.map(([line]) => JSON.parse(String(line))).filter((e) => e.event === 'compaction.stalled');
  const held = async (name: string, head: number) => {
    const { env, fake } = pipeline();
    const { owner, id } = await setup(name, env);
    fake.failing = true;
    await grow(owner, id, head);
    await emitChangeLog(env, id);
    return { id, answer: await compact(env, id) };
  };
  // Held, and not for long: reported to the caller, and no one is woken.
  const brief = await held('held_briefly', 1_100);
  expect(brief.answer).toMatchObject({ segments: 0, held: { by: 'changelog', stalled: false } });
  expect(stalls()).toEqual([]);
  // Eight segments past due: a hold no passing backlog explains.
  const stuck = await held('held_for_long', 9_300);
  expect(stuck.answer).toMatchObject({ segments: 0, floor: 0, held: { by: 'changelog', stalled: true } });
  expect(stalls()).toMatchObject([{ repo: stuck.id, by: 'changelog', floor: 0, stalled: true }]);
  logged.mockRestore();
}, 60_000);

it('compacts past a stopped stream too far behind the head and jumps its cursor', async () => {
  const { env, fake } = pipeline();
  const { owner, id, land } = await setup('faraway', env);
  fake.failing = true;
  const head = await grow(owner, id, 17_500);
  await emitChangeLog(env, id);
  expect(await changeLogHold(env, id)).toBe(1);

  expect(await compact(env, id)).toMatchObject({ segments: 8, floor: 8 * 1_024 });
  expect(await cursorOf(id)).toMatchObject({ version: head, gaps: 1, last_gap: { from: 1, to: head, reason: 'size' } });
  fake.failing = false;
  await land('after.txt');
  await emitChangeLog(env, id);
  expect(fake.sent.flat().map((e) => e.event_key)).toEqual([`${id}:v${head + 1}`]);
}, 120_000);

it('keeps a jump when the job that claimed the range below it fails afterwards', async () => {
  let release!: (ok: boolean) => void;
  let sending!: () => void;
  const started = new Promise<void>((r) => {
    sending = r;
  });
  const gate = new Promise<boolean>((r) => {
    release = r;
  });
  const CHANGELOG = {
    send: async () => {
      sending();
      if (!(await gate)) throw new Error('pipeline unavailable');
    },
  };
  const env = { ...scoped, CHANGELOG } as unknown as Env;
  const { id, land } = await setup('jumper', env);
  await land('a.txt');
  const emitting = emitChangeLog(env, id);
  await started;
  expect((await skipChangeLog(env, id, 40, 'size'))?.version).toBe(40);
  release(false);
  await emitting;
  expect(await cursorOf(id)).toMatchObject({ version: 40, claims: {}, failures: 1 });
  // Never backwards: a jump behind the cursor is no gap.
  expect((await skipChangeLog(env, id, 30, 'size'))?.gaps).toBe(1);
});

it('never lets an unreadable cursor stop compaction', async () => {
  const { env } = pipeline();
  const { id } = await setup('junk', env);
  await bindings.OBJECTS.put(cursorKey(id), 'not json');
  expect(await changeLogHold(env, id)).toBeUndefined();
  await expect(emitChangeLog(env, id)).resolves.toBeTruthy();
  await expect(skipChangeLog(env, id, 9, 'age')).resolves.toBeNull();
});

it('splits a page into requests under the 5 MB limit', () => {
  const event = (n: number) => ({ event_key: `k${n}`, repo: 'x'.repeat(1_500_000) });
  const batches = sendBatches([event(1), event(2), event(3), event(4), event(5)]);
  expect(batches.flat()).toHaveLength(5);
  for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThan(5_000_000);
  expect(batches.length).toBeGreaterThan(1);
  expect(sendBatches([])).toEqual([]);
});
