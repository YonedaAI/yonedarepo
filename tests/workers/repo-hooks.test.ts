// B3 webhooks through the real authority (workerd) with a stub receiver in place of the
// outside URL: signed deliveries that verify, retries with a delivery log, order across
// landings, deletion stopping delivery, grant-limited payloads and SSRF refusals.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { deliverHook } from '../../cloudflare/worker/repo-hooks';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Received = { headers: Headers; body: string; json: any };
/** The outside receiver: records each POST and answers with the next scripted status. */
function receiver(statuses: number[] = []) {
  const got: Received[] = [];
  const send = async (req: Request) => {
    const body = await req.text();
    got.push({ headers: req.headers, body, json: JSON.parse(body) });
    return new Response('ok', { status: statuses.shift() ?? 200 });
  };
  return { got, send };
}

async function verifies(secret: string, received: Received) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const hex = received.headers.get('x-yoneda-signature')?.replace(/^sha256=/, '') ?? '';
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => Number.parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(received.body));
}

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const policy = { required_checks: [], approvals: 0 };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('README.md', '# hooks\n')], author } });
  const id = created.body.id as string;
  const hook = async (body: object = {}) => {
    const made = await api(`/repos/${id}/hooks`, owner, { body: { url: 'https://ci.example.com/hook', ...body } });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    return made.body as { id: number; secret: string };
  };
  const land = async (path: string, message = 'confidential message') => {
    const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file(path, 'private body\n')], message, author } });
    const landed = await api(`/repos/${id}/land`, owner, { body: { ref: 'main', commit: made.body.commit } });
    expect(landed.body.landed).toBe(true);
    return made.body.commit as string;
  };
  const derive = () => deriveAfterLanding(scoped, { v: 1, kind: 'platform_derive', repo_id: id, job_id: 'main' });
  /** The delivery jobs fan-out queued. */
  const jobs = () => queued.filter((m) => m.kind === 'platform_hooks' && m.repo_id === id);
  return { owner, id, hook, land, derive, jobs };
}

/** Lets a backing-off payload be retried now (the authority's clock is real time). */
const elapse = (repo: string) =>
  runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo)), async (_i, state) => {
    state.storage.sql.exec('UPDATE hook_outbox SET next_at=0');
  });

it('delivers one signed land event whose signature verifies, without contents', async () => {
  const { owner, id, hook, land, derive, jobs } = await setup('hooked');
  const made = await hook({ events: ['land'] });
  expect(made.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  const listed = await api(`/repos/${id}/hooks`, owner);
  expect(JSON.stringify(listed.body)).not.toContain(made.secret);
  const commit = await land('src/a.txt');
  await derive();
  expect(jobs().map((j) => j.job_id)).toEqual([`hook:${made.id}`]);
  const { got, send } = receiver();
  expect(await deliverHook(scoped, id, made.id, send)).toEqual({});
  expect(got).toHaveLength(1);
  expect(await verifies(made.secret, got[0])).toBe(true);
  expect(await verifies('whsec_wrong', got[0])).toBe(false);
  expect(got[0].headers.get('x-yoneda-event')).toBe('land');
  expect(got[0].headers.get('x-yoneda-delivery')).toBe(got[0].json.delivery_id);
  expect(got[0].json).toMatchObject({ event: 'land', repo: id, ref: 'refs/heads/main', commit, after: commit, version: 2 });
  for (const field of ['before', 'actor', 'at']) expect(got[0].json, field).toHaveProperty(field);
  expect(got[0].body).not.toContain('private body');
  expect(got[0].body).not.toContain('src/a.txt');
  // Nothing is sent twice.
  expect(await deliverHook(scoped, id, made.id, send)).toEqual({});
  expect(got).toHaveLength(1);
});

it('retries a failing receiver through the queue job and logs every attempt', async () => {
  const { owner, id, hook, land, derive, jobs } = await setup('retried');
  const made = await hook({ events: ['land'] });
  await land('a.txt');
  await derive();
  const { got, send } = receiver([500]);
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith('https://ci.example.com/')
      ? send(input as Request)
      : original(input, init)) as typeof fetch;
  const run = async () => {
    const retries: number[] = [];
    let acked = 0;
    await platformJob(scoped, { body: jobs()[0], attempts: 1, ack: () => void acked++, retry: (o: any) => void retries.push(o.delaySeconds) } as unknown as Message<any>);
    return { retries, acked };
  };
  try {
    expect(await run()).toEqual({ retries: [10], acked: 0 });
    expect(got).toHaveLength(1);
    // Still backing off: the job comes back later without sending.
    expect((await run()).retries[0]).toBeGreaterThan(0);
    expect(got).toHaveLength(1);
    await elapse(id);
    expect(await run()).toEqual({ retries: [], acked: 1 });
  } finally {
    globalThis.fetch = original;
  }
  expect(got.map((g) => g.json.delivery_id)).toEqual([got[0].json.delivery_id, got[0].json.delivery_id]);
  expect(got[1].body).toBe(got[0].body);
  const log = await api(`/repos/${id}/hooks/${made.id}/deliveries`, owner);
  expect(log.body.deliveries.map((d: any) => [d.attempt, d.ok, d.status])).toEqual([
    [2, true, 200],
    [1, false, 500],
  ]);
  const listed = await api(`/repos/${id}/hooks`, owner);
  expect(listed.body.hooks[0]).toMatchObject({ active: true, failures: 0, pending: 0 });
});

it('keeps log order across three landings', async () => {
  const { id, hook, land, derive } = await setup('ordered');
  const made = await hook({ events: ['land'] });
  const commits = [await land('one.txt'), await land('two.txt'), await land('three.txt')];
  await derive();
  const { got, send } = receiver();
  await deliverHook(scoped, id, made.id, send);
  expect(got.map((g) => [g.json.version, g.json.commit])).toEqual(commits.map((c, i) => [i + 2, c]));
});

it('stops delivering once the hook is deleted', async () => {
  const { owner, id, hook, land, derive } = await setup('deleted');
  const made = await hook();
  await land('a.txt');
  await derive();
  const removed = await api(`/repos/${id}/hooks/${made.id}`, owner, { method: 'DELETE' });
  expect(removed.body).toMatchObject({ deleted: true });
  const { got, send } = receiver();
  expect(await deliverHook(scoped, id, made.id, send)).toEqual({});
  expect(got).toHaveLength(0);
  expect((await api(`/repos/${id}/hooks/${made.id}/deliveries`, owner)).status).toBe(404);
});

it('redacts messages outside a hook grant and refuses restricted or unsafe management', async () => {
  const { owner, id, hook, land, derive } = await setup('redacted');
  const open = await hook({ events: ['land'] });
  const limited = await hook({ events: ['land'], paths: ['docs/'] });
  await land('src/secret.rs', 'rotate the vault key');
  await derive();
  const [seen, hidden] = [receiver(), receiver()];
  await deliverHook(scoped, id, open.id, seen.send);
  await deliverHook(scoped, id, limited.id, hidden.send);
  expect(seen.got[0].json.message).toBe('rotate the vault key');
  expect(hidden.got[0].json).toMatchObject({ event: 'land', repo: id });
  expect(hidden.got[0].json).not.toHaveProperty('message');
  expect(hidden.got[0].body).not.toContain('vault');

  // A directory-limited token cannot manage hooks; unsafe targets are refused.
  const token = await api(`/repos/${id}/tokens`, owner, { body: { name: 'docs', scopes: ['read', 'write'], paths: ['docs/'] } });
  const restricted = { token: token.body.token as string };
  expect((await api(`/repos/${id}/hooks`, restricted)).status).toBe(403);
  expect((await api(`/repos/${id}/hooks`, restricted, { body: { url: 'https://ci.example.com/x' } })).status).toBe(403);
  for (const url of ['http://ci.example.com/', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://anything.workers.dev/']) {
    const refused = await api(`/repos/${id}/hooks`, owner, { body: { url } });
    expect(refused.status, url).toBe(400);
    expect(refused.body.error.message).toMatch(/Hook URL refused/);
  }
});
