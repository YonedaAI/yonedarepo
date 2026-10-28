// Public and private repositories end to end: without credentials a public repository's
// API reads, Git fetches, LFS downloads and release assets are served, and a private one
// is NOT_FOUND to the API (as to a signed-in stranger) and a 401 to Git; nobody but members
// writes; a flip to private stops anonymous reads before its answer returns; discovery
// lists only public repositories.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const anonymous = {};
const MEDIA = 'application/vnd.git-lfs+json';
const lfsEnv = {
  ...scoped,
  LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  LFS_S3_BUCKET: 'yoneda-local-test',
  LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id',
  LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret',
} as Env;

async function raw(url: string, init: RequestInit = {}, target: Env = scoped) {
  const response = await platformFetch(new Request(`https://yoneda${url}`, init), target);
  return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
async function clone(id: string, main: string) {
  const wants = `${pkt(`want ${main} multi_ack_detailed side-band-64k\n`)}0000${pkt('done\n')}`;
  return raw(`/git/${id}.git/git-upload-pack`, { method: 'POST', body: wants });
}
const lfsBatch = (id: string, operation: string) =>
  raw(
    `/git/${id}.git/info/lfs/objects/batch`,
    {
      method: 'POST',
      headers: { accept: MEDIA, 'content-type': MEDIA },
      body: JSON.stringify({ operation, objects: [{ oid: 'a'.repeat(64), size: 3 }] }),
    },
    lfsEnv,
  );
const visibility = (id: string, cookie: string, value: string) =>
  api(`/repos/${id}/visibility`, { cookie }, { method: 'PUT', body: { visibility: value } });

/** GET reads a repository page makes, each with what a public reader must be served. */
const reads = (id: string, main: string) => [
  `/repos/${id}`,
  `/repos/${id}/refs`,
  `/repos/${id}/log?ref=main`,
  `/repos/${id}/tree?ref=main`,
  `/repos/${id}/blob?path=README.md`,
  `/repos/${id}/commits/${main}`,
  `/repos/${id}/diff?from=${main}&to=${main}`,
  `/repos/${id}/search?query=public`,
  `/repos/${id}/blame?path=README.md`,
  `/repos/${id}/views/human`,
  `/repos/${id}/changes`,
  `/repos/${id}/releases`,
  `/repos/${id}/sessions`,
  `/repos/${id}/contracts`,
];

it('serves a public repository to anyone and keeps a private one invisible', async () => {
  const cookie = await signup('vis_owner');
  const stranger = { cookie: await signup('vis_stranger') };
  const created = await api('/repos', { cookie }, {
    body: { name: 'open', visibility: 'public', policy: { required_checks: [], approvals: 0 }, files: [file('README.md', '# public\n')], author },
  });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const closed = (await api('/repos', { cookie }, { body: { name: 'closed', files: [file('README.md', '# private\n')], author } })).body.id as string;
  const main = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'] as string;
  const closedMain = (await api(`/repos/${closed}/refs`, { cookie })).body.refs['refs/heads/main'] as string;

  // Every read a repository page makes, without a session or token.
  for (const path of reads(id, main)) {
    const read = await api(path, anonymous);
    expect([path, read.status]).toEqual([path, 200]);
  }
  const status = (await api(`/repos/${id}`, anonymous)).body;
  expect(status.visibility).toBe('public');
  expect(status.viewer).toEqual({ principal: 'anonymous', owner: false, role: null, public: true });
  expect((await api(`/repos/${id}/blob?path=README.md`, anonymous)).body.content).toBe('# public\n');
  expect((await api(`/repos/${id}`, stranger)).body.viewer).toMatchObject({ principal: 'user:vis_stranger', public: true });

  // A private repository (and one that does not exist) is NOT_FOUND alike, signed in or not.
  for (const who of [anonymous, stranger])
    for (const path of [...reads(closed, closedMain), '/repos/r00000000000000000000'])
      expect([path, (await api(path, who)).status]).toEqual([path, 404]);

  // Nobody gains write: anonymous writes are 401, a stranger's 403; settings stay the owner's.
  const commit = { ref: 'main', changes: [file('x.md', 'x\n')], message: 'x', author };
  expect((await api(`/repos/${id}/commits`, anonymous, { body: commit })).status).toBe(401);
  expect((await api(`/repos/${id}/commits`, stranger, { body: commit })).status).toBe(403);
  for (const path of ['tokens', 'members', 'hooks'])
    expect((await api(`/repos/${id}/${path}`, stranger)).status).toBe(403);
  expect((await visibility(id, stranger.cookie, 'private')).status).toBe(403);
  expect((await api('/repos', anonymous)).status).toBe(401);
  // A refused token never reads as anonymous.
  expect((await api(`/repos/${id}`, { token: 'yrp_not-a-real-token' })).status).toBe(401);
  expect((await api(`/repos/${id}/mcp`, anonymous, { body: {} })).status).toBe(401);

  // Stock Git without credentials: a public clone, a 401 for a push and for a private repository.
  const advertised = await raw(`/git/${id}.git/info/refs?service=git-upload-pack`);
  expect(advertised.status).toBe(200);
  expect(new TextDecoder().decode(advertised.bytes)).toContain(main);
  const cloned = await clone(id, main);
  expect(cloned.status).toBe(200);
  expect(new TextDecoder().decode(cloned.bytes)).toContain('PACK');
  for (const path of [
    `/git/${id}.git/info/refs?service=git-receive-pack`,
    `/git/${closed}.git/info/refs?service=git-upload-pack`,
    '/git/r00000000000000000000.git/info/refs?service=git-upload-pack',
  ]) {
    const refused = await raw(path);
    expect([path, refused.status, refused.headers.get('www-authenticate')]).toEqual([path, 401, 'Basic realm="YonedaRepo"']);
  }
  expect((await clone(closed, closedMain)).status).toBe(401);

  // LFS: anonymous downloads of a public repository; uploads and private ones ask for credentials.
  expect((await lfsBatch(id, 'download')).status).toBe(200);
  expect((await lfsBatch(id, 'upload')).status).toBe(401);
  expect((await lfsBatch(closed, 'download')).status).toBe(401);
});

it('lets a signed-in account fork a public repository, never anonymous', async () => {
  // R2-backed stores fork in this fixture (its Artifacts fake cannot).
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2', ARTIFACTS: undefined } as unknown as Env;
  const cookie = await signup('vis_fork_owner');
  const stranger = { cookie: await signup('vis_forker') };
  const make = async (name: string, value: string) =>
    (await api('/repos', { cookie }, { body: { name, visibility: value, files: [file('a.md', 'a\n')], author } }, local)).body.id as string;
  const [open, closed] = [await make('upstream', 'public'), await make('hidden', 'private')];
  const fork = await api(`/repos/${open}/fork`, stranger, { body: { name: 'mine' } }, local);
  expect([fork.status, fork.body.parent]).toEqual([200, open]);
  // A fork is private (and the forker's) whatever its parent is.
  const forked = (await api(`/repos/${fork.body.id}`, stranger, {}, local)).body;
  expect([forked.visibility, forked.viewer.owner]).toEqual(['private', true]);
  expect((await api(`/repos/${fork.body.id}/blob?path=a.md`, stranger, {}, local)).body.content).toBe('a\n');
  expect((await api(`/repos/${open}/fork`, anonymous, { body: {} }, local)).status).toBe(401);
  expect((await api(`/repos/${closed}/fork`, stranger, { body: {} }, local)).status).toBe(404);
});

it('serves release assets anonymously only while public, and a flip to private holds at once', async () => {
  const cookie = await signup('vis_release');
  const id = (await api('/repos', { cookie }, { body: { name: 'rel', files: [file('README.md', 'r\n')], author } })).body.id as string;
  const main = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'] as string;
  expect((await api(`/repos/${id}/tags`, { cookie }, { body: { name: 'v1', commit: main, message: 'v1' } })).status).toBe(200);
  expect((await api(`/repos/${id}/releases`, { cookie }, { body: { tag: 'v1', title: 'One' } })).status).toBe(200);
  const bytes = new TextEncoder().encode('asset\n');
  const put = await raw(`/api/v1/repos/${id}/releases/v1/assets/a.bin`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const download = () => raw(`/api/v1/repos/${id}/releases/v1/assets/a.bin`);
  expect((await download()).status).toBe(404);

  expect((await visibility(id, cookie, 'public')).body).toEqual({ visibility: 'public', changed: true });
  const served = await download();
  expect([served.status, new TextDecoder().decode(served.bytes)]).toEqual([200, 'asset\n']);
  // Warm this isolate's published head with an anonymous read, then flip back.
  expect((await api(`/repos/${id}/tree?ref=main`, anonymous)).status).toBe(200);
  expect((await visibility(id, cookie, 'private')).body).toEqual({ visibility: 'private', changed: true });
  expect((await api(`/repos/${id}/tree?ref=main`, anonymous)).status).toBe(404);
  expect((await api(`/repos/${id}/blob?path=README.md`, anonymous)).status).toBe(404);
  expect((await download()).status).toBe(404);
  expect((await raw(`/git/${id}.git/info/refs?service=git-upload-pack`)).status).toBe(401);
  // The owner still reads; an invalid visibility is refused.
  expect((await api(`/repos/${id}/tree?ref=main`, { cookie })).status).toBe(200);
  expect((await visibility(id, cookie, 'internal')).status).toBe(400);
});

it('lists only public repositories for discovery, and each account its own with visibility', async () => {
  const cookie = await signup('vis_explore');
  const make = async (name: string, value?: string) =>
    (await api('/repos', { cookie }, { body: { name, ...(value && { visibility: value }) } })).body.id as string;
  const one = await make('one', 'public');
  const two = await make('two');
  const three = await make('three', 'public');
  const listed = (await api('/explore', anonymous)).body.repos.map((r: { id: string }) => r.id);
  expect(listed).toEqual([three, one]);
  const page = (await api('/explore?limit=1', anonymous)).body.repos;
  expect(page).toEqual([expect.objectContaining({ id: three, name: 'three', owner: 'vis_explore', visibility: 'public' })]);
  const next = (await api(`/explore?limit=1&before=${page[0].created_at}`, anonymous)).body.repos;
  expect(next.map((r: { id: string }) => r.id)).toEqual([one]);

  // Made private: gone from discovery; made public: listed.
  await visibility(three, cookie, 'private');
  await visibility(two, cookie, 'public');
  expect((await api('/explore', anonymous)).body.repos.map((r: { id: string }) => r.id)).toEqual([two, one]);
  const mine = (await api('/repos', { cookie })).body.repos;
  expect(Object.fromEntries(mine.map((r: { name: string; visibility: string }) => [r.name, r.visibility]))).toEqual({
    one: 'public',
    two: 'public',
    three: 'private',
  });
  expect((await api('/repos', { cookie }, { body: { name: 'bad', visibility: 'internal' } })).status).toBe(400);

  // /explore on the platform host is the web app's page.
  const page2 = await raw('/explore');
  expect([page2.status, page2.headers.get('location')]).toEqual([302, 'https://yoneda/source/explore']);
});

it('rate limits requests without credentials per address', async () => {
  const cookie = await signup('vis_limit');
  const id = (await api('/repos', { cookie }, { body: { name: 'lim', visibility: 'public' } })).body.id as string;
  let calls = 0;
  const limiter = { limit: async () => ({ success: ++calls <= 2 }) };
  const limited = { ...scoped, PUBLIC_LIMITER: limiter } as unknown as Env;
  const get = (path: string) => api(path, anonymous, {}, limited);
  expect((await get(`/repos/${id}`)).status).toBe(200);
  expect((await get(`/repos/${id}/refs`)).status).toBe(200);
  const over = await get(`/repos/${id}/refs`);
  expect([over.status, over.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  const git = await raw(`/git/${id}.git/info/refs?service=git-upload-pack`, {}, limited);
  expect(git.status).toBe(429);
  // Signed-in reads are not counted against it.
  expect((await api(`/repos/${id}/refs`, { cookie }, {}, limited)).status).toBe(200);
});
