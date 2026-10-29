// Quarantine through the Worker: once the owner quarantines a blob, no read path serves its
// bytes (file reads at main and at a commit, the object fetch and download, blame, diff
// patches, search, Git over HTTPS, a direct clone), in this isolate and in a fresh one; a
// partial clone without it still works. Purge deletes its bytes from R2 and the derived
// caches, and a quarantined session record reads masked.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { packKey } from '../../cloudflare/worker/repo-pack-cache';
import { transcriptKey } from '../../cloudflare/worker/repo-session-records';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, delayed, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';
import { fakeBuilders } from './repo-pack-fixture';

usePlatformFixture();

const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
const SECRET = 'staging password: hunter2-quarantine\n';

async function blobId(text: string) {
  const content = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...header, ...content]));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const fetchCommand = (args: string[]) =>
  `${pkt('command=fetch\n')}${pkt('agent=git/2.47.0\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;

async function setUp(name: string, env: Env = local) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, {
    body: {
      name: 'leaky',
      policy: { required_checks: [], approvals: 0 },
      files: [file('config/staging.txt', SECRET), file('src/app.txt', 'hello\n')],
      author,
      tokens: [{ name: 'reader', scopes: ['read'] }, { name: 'writer', scopes: ['read', 'write'] }],
    },
  }, env);
  expect(created.status).toBe(200);
  await drainObjects(env);
  return {
    cookie,
    id: created.body.id as string,
    commit: created.body.commit as string,
    reader: { token: created.body.tokens[0].token as string },
    writer: { token: created.body.tokens[1].token as string },
  };
}

/** Test harness only: workerd invalidates each Durable Object once after a module reload
 * (`vi.resetModules`) and asks for the call to be retried. */
const retried =
  (call: typeof api): typeof api =>
  async (...args) => {
    const first = await call(...args);
    return /invalidating this Durable Object/.test(first.body?.error?.message ?? '') ? call(...args) : first;
  };

async function keys(prefix: string) {
  return (await bindings.OBJECTS.list({ prefix })).objects.map((o) => o.key);
}

it('serves a quarantined blob on no read path, in any isolate, until and after purge', async () => {
  const { cookie, id, commit, reader, writer } = await setUp('quarantine_owner');
  const repo = `/repos/${id}`;
  const blob = await blobId(SECRET);
  const read = (path: string) => api(`${repo}/blob?path=${path}`, reader, {}, local);
  expect((await read('config/staging.txt')).body.content).toBe(SECRET);
  // Built before the quarantine: the index would hold the content.
  expect((await api(`${repo}/search?query=hunter2`, reader, {}, local)).body.results).toHaveLength(1);

  // Only the owner side quarantines.
  const ask = { path: 'config/staging.txt', reason: 'a staging password' };
  for (const who of [reader, writer])
    expect((await api(`${repo}/quarantine`, who, { body: ask }, local)).status).toBe(403);
  const made = await api(`${repo}/quarantine`, { cookie }, { body: ask }, local);
  expect(made.status).toBe(200);
  expect(made.body.record).toMatchObject({ target: { kind: 'blob', id: blob }, path: 'config/staging.txt', state: 'quarantined' });
  // The job is scheduled for when the retention ends.
  expect(delayed.filter((m) => m.kind === 'platform_quarantine' && m.repo_id === id)).toHaveLength(1);

  const refused = async (pending: Promise<{ status: number; body: any }>, what: string) => {
    const answer = await pending;
    expect([answer.status, answer.body.error?.code], `${what}: ${JSON.stringify(answer.body)}`).toEqual([451, 'QUARANTINED']);
    expect(answer.body.error.message, what).toContain(blob);
    expect(JSON.stringify(answer.body), what).not.toContain('hunter2');
  };
  const everyRead = async (call: typeof api) => {
    await refused(call(`${repo}/blob?path=config/staging.txt`, reader, {}, local), 'main');
    await refused(call(`${repo}/blob?path=config/staging.txt&commit=${commit}`, reader, {}, local), 'commit');
    await refused(call(`${repo}/blame?path=config/staging.txt`, reader, {}, local), 'blame');
    await refused(call(`${repo}/objects`, reader, { body: { objects: [{ id: blob, kind: 'blob' }] } }, local), 'objects');
    // The other file still reads.
    expect((await call(`${repo}/blob?path=src/app.txt`, reader, {}, local)).body.content).toBe('hello\n');
  };
  await everyRead(api);
  const download = await api(`${repo}/objects/${blob}`, reader, {}, local);
  expect(download.status).toBe(451);
  // A diff lists the change and withholds its patch.
  const diff = await api(`${repo}/diff?head=${commit}&patch=1`, reader, {}, local);
  const change = diff.body.changes.find((c: any) => c.path === 'config/staging.txt');
  expect([diff.status, change.patch_omitted]).toEqual([200, 'quarantined']);
  expect(JSON.stringify(diff.body)).not.toContain('hunter2');
  // Search: the index is rebuilt without the content; the path still matches.
  const byContent = await api(`${repo}/search?query=hunter2`, reader, {}, local);
  expect(byContent.body.results, JSON.stringify(byContent.body)).toEqual([]);
  const byPath = await api(`${repo}/search?query=staging`, reader, {}, local);
  expect(byPath.body.results).toEqual([
    { path: 'config/staging.txt', id: blob, match: 'path', hits: 0, lines: [] },
  ]);

  // A fresh isolate (its own head copies and caches) decides the same.
  vi.resetModules();
  const fresh = await import('../../cloudflare/worker/platform-routes');
  const isolate = retried(async (path, auth, init = {}, target = scoped) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    const response = await fresh.platformFetch(
      new Request(`https://yoneda/api/v1${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
      target,
    );
    return { status: response.status, body: (await response.json()) as any };
  });
  await everyRead(isolate);
  // This module graph meets the same one-time invalidation from here on.
  const call = retried(api);

  // Purge needs the blob id as confirmation, then deletes the bytes and derived copies.
  const record = made.body.record.id;
  const wrong = await call(`${repo}/quarantine/${record}/purge`, { cookie }, { body: { confirm: 'x' } }, local);
  expect(wrong.status).toBe(400);
  const stored = [`platform/v1/${id}/git/${blob}`, `store/v1/yr-${id}/objects/${blob}`];
  const present = (await Promise.all(stored.map((k) => bindings.OBJECTS.head(k)))).filter(Boolean);
  expect(present.length).toBeGreaterThan(0);
  expect((await keys(`derived/v1/${id}/search/`)).length).toBeGreaterThan(0);
  const purged = await call(`${repo}/quarantine/${record}/purge`, { cookie }, { body: { confirm: blob } }, local);
  expect([purged.status, purged.body.purged]).toEqual([200, 1]);
  for (const key of [...stored, `platform/v1/${id}/objects/${blob}`])
    expect(await bindings.OBJECTS.head(key), key).toBeNull();
  expect(await keys(`derived/v1/${id}/search/`)).toEqual([]);
  expect(await keys(`platform/v1/${id}/seeds/`)).toEqual([]);
  const listed = await call(`${repo}/quarantine`, { cookie }, {}, local);
  expect(listed.body.records[0]).toMatchObject({ state: 'purged', reason: 'a staging password' });
  await everyRead(call);
  await everyRead(isolate);
});

it('refuses a Git fetch that needs a quarantined blob, naming it, and serves one without it', async () => {
  const { cookie, id, reader } = await setUp('quarantine_git', scoped);
  const blob = await blobId(SECRET);
  const main = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'];
  const git = async (body: string) => {
    const response = await platformFetch(
      new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`git:${reader.token}`)}`, 'git-protocol': 'version=2' },
        body,
      }),
      scoped,
    );
    return { status: response.status, text: await response.text() };
  };
  expect((await git(fetchCommand([`want ${main}`, 'done']))).text).toContain('packfile');
  const made = await api(`/repos/${id}/quarantine`, { cookie }, { body: { blob, path: 'config/staging.txt', reason: 'leak' } });
  expect(made.status).toBe(200);

  const full = await git(fetchCommand([`want ${main}`, 'done']));
  expect(full.status).toBe(200);
  expect(full.text).toMatch(/ERR QUARANTINED: Blob [0-9a-f]{40} \(config\/staging\.txt\) is quarantined/);
  // Nothing of the pack is sent: Git stops at the ERR line (`remote error: …`).
  expect(full.text).not.toContain('PACK');
  // A partial clone leaves blobs out and completes; its lazy fetch of the blob is refused.
  const partial = await git(fetchCommand([`want ${main}`, 'filter blob:none', 'done']));
  expect(partial.text).toContain('packfile');
  const lazy = await git(fetchCommand([`want ${blob}`, 'filter blob:none', 'done']));
  expect(lazy.text).toContain('ERR QUARANTINED');
  // A direct Artifacts clone would serve every blob: refused while any is withheld.
  const clone = await api(`/repos/${id}/clone`, { cookie }, { body: {} });
  expect([clone.status, clone.body.error?.code]).toEqual([451, 'QUARANTINED']);

  // Released: served again.
  const released = await api(`/repos/${id}/quarantine/${made.body.record.id}/release`, { cookie }, { body: {} });
  expect(released.body.record.state).toBe('released');
  expect((await git(fetchCommand([`want ${main}`, 'done']))).text).toContain('packfile');
});

it('purges due records in the quarantine job, and withholds a quarantined session record and its transcript', async () => {
  const { cookie, id, commit, reader } = await setUp('quarantine_job');
  const repo = `/repos/${id}`;
  const transcript = { context: 'main at abc1234', turns: [{ kind: 'prompt', text: 'the password is hunter2' }] };
  const session = await api(`${repo}/commits/${commit}/sessions`, { cookie }, {
    body: { cli: 'claude-code', summary: 'used the staging password', transcript },
  }, local);
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  const sid = session.body.session;
  const sha = (await api(`${repo}/sessions/${sid}`, reader, {}, local)).body.session.transcript.sha256 as string;
  expect(await bindings.OBJECTS.head(transcriptKey(id, sha))).not.toBeNull();
  await api(`${repo}/quarantine`, { cookie }, { body: { session: sid, reason: 'names a password', retain_days: 1 } }, local);
  const shown = await api(`${repo}/sessions/${sid}`, reader, {}, local);
  expect(shown.body.session).toMatchObject({ summary: null, transcript_ref: null, transcript: null, quarantined: true });
  const document = await api(`${repo}/sessions/${sid}/transcript`, reader, {}, local);
  expect([document.status, document.body.error?.code]).toEqual([451, 'QUARANTINED']);
  expect(JSON.stringify(document.body)).not.toContain('hunter2');
  const blob = await blobId(SECRET);
  await api(`${repo}/quarantine`, { cookie }, { body: { blob, reason: 'leak', retain_days: 1 } }, local);
  const job = delayed.find((m) => m.kind === 'platform_quarantine' && m.repo_id === id);
  // Not due yet: nothing is purged.
  const run = () => platformJob(local, { body: job, attempts: 1, ack: () => {}, retry: () => {} } as unknown as Message<any>);
  await run();
  expect((await api(`${repo}/quarantine`, { cookie }, {}, local)).body.records.map((r: any) => r.state)).toEqual(['quarantined', 'quarantined']);
  // Test-only: the retention has passed (the authority's clock cannot be moved).
  await runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(id)), async (_i, state) => {
    state.storage.sql.exec('UPDATE quarantine SET purge_after=1');
  });
  await run();
  const records = (await api(`${repo}/quarantine`, { cookie }, {}, local)).body.records;
  expect(records.map((r: any) => [r.target.kind, r.state, r.purged_by])).toEqual([
    ['blob', 'purged', 'platform:quarantine'],
    ['session', 'purged', 'platform:quarantine'],
  ]);
  expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${blob}`)).toBeNull();
  expect((await api(`${repo}/sessions/${sid}`, reader, {}, local)).body.session.summary).toBeNull();
  // The transcript document is gone; the record still refuses it.
  expect(await bindings.OBJECTS.head(transcriptKey(id, sha))).toBeNull();
  expect((await api(`${repo}/sessions/${sid}/transcript`, reader, {}, local)).status).toBe(451);
});

it("withholds a blob a fork inherits once its parent quarantines it", async () => {
  const alice = { cookie: await signup('quarantine_parent') };
  const bob = { cookie: await signup('quarantine_forker') };
  const created = await api('/repos', alice, {
    body: { name: 'upstream', files: [file('config/staging.txt', SECRET), file('a.md', 'a\n')], author },
  }, local);
  const parent = created.body.id as string;
  await drainObjects(local);
  await api(`/repos/${parent}/members`, alice, { body: { account: 'quarantine_forker', role: 'read' } }, local);
  const fork = (await api(`/repos/${parent}/fork`, bob, { body: { name: 'mine' } }, local)).body.id as string;
  expect((await api(`/repos/${fork}/blob?path=config/staging.txt`, bob, {}, local)).body.content).toBe(SECRET);

  const blob = await blobId(SECRET);
  expect((await api(`/repos/${parent}/quarantine`, alice, { body: { blob, reason: 'leak' } }, local)).status).toBe(200);
  for (const path of [`/repos/${fork}/blob?path=config/staging.txt`, `/repos/${fork}/objects/${blob}`]) {
    const read = await api(path, bob, {}, local);
    expect([read.status, read.body.error?.code], path).toEqual([451, 'QUARANTINED']);
  }
  expect((await api(`/repos/${fork}/blob?path=a.md`, bob, {}, local)).body.content).toBe('a\n');
});

it('never serves or builds a stored pack of any kind while a blob is withheld, and purge deletes them', async () => {
  const builders = fakeBuilders(() => cached);
  const cached = { ...scoped, PACK_CACHE: 'on', PACK_BUILD_MIN_OBJECTS: '0', PACK_BUILDERS: builders.namespace } as unknown as Env;
  const { cookie, id, reader } = await setUp('quarantine_packs', cached);
  const main = (await api(`/repos/${id}/refs`, { cookie }, {}, cached)).body.refs['refs/heads/main'];
  const secret = await blobId(SECRET);
  const none = { omit_blobs: false, depth: null, deepen_relative: false };
  // A full, a partial and a shallow clone, and a partial clone's checkout of the file.
  const kinds = [
    { fresh: { ...none, wants: [main] }, args: [`want ${main}`, 'done'] },
    { fresh: { ...none, wants: [main], omit_blobs: true }, args: [`want ${main}`, 'filter blob:none', 'done'] },
    { fresh: { ...none, wants: [main], depth: 1 }, args: [`want ${main}`, 'deepen 1', 'done'] },
    { fresh: { ...none, wants: [secret], omit_blobs: true }, args: [`want ${secret}`, 'filter blob:none', 'done'] },
  ];
  const clone = async (args: string[]) => {
    const response = await platformFetch(
      new Request(`https://yoneda/git/${id}.git/git-upload-pack`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`git:${reader.token}`)}`, 'git-protocol': 'version=2' },
        body: fetchCommand(args),
      }),
      cached,
    );
    return new TextDecoder('latin1').decode(new Uint8Array(await response.arrayBuffer()));
  };
  // Test-only stand-ins for packs earlier clones stored (each holds the blob's bytes).
  for (const { fresh } of kinds) await bindings.OBJECTS.put(await packKey(id, fresh), new TextEncoder().encode(`PACK stand-in ${SECRET}`));
  for (const { args } of kinds) expect(await clone(args)).toContain('hunter2');
  const made = await api(`/repos/${id}/quarantine`, { cookie }, { body: { path: 'config/staging.txt', reason: 'leak' } }, cached);
  for (const { args } of kinds) {
    const answer = await clone(args);
    expect(answer, args.join(' ')).not.toContain('stand-in');
    expect(answer, args.join(' ')).not.toContain('hunter2');
  }
  expect(await clone(kinds[0].args)).toContain('ERR QUARANTINED');
  const blob = made.body.record.target.id;
  await api(`/repos/${id}/quarantine/${made.body.record.id}/purge`, { cookie }, { body: { confirm: blob } }, cached);
  expect(await keys(`derived/v1/${id}/packs/`)).toEqual([]);
  // A pack-build job (after a push, or handed a clone's fetch) stores nothing while the
  // blob is withheld.
  const job = { v: 1, kind: 'platform_pack_build', repo_id: id, job_id: `push-${main}` };
  await platformJob(cached, { body: job, attempts: 1, ack: () => {}, retry: () => {} } as unknown as Message<any>);
  expect(await keys(`derived/v1/${id}/packs/`)).toEqual([]);
  expect(builders.record.started).toBe(0);
});
