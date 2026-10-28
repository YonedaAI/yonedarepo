// A request without credentials wakes no repository object until the discovery index
// (D1 platform_repos.visibility) lists the repository as public: a private or unknown one
// gets today's refusal without touching its authority. The authority still decides: a
// lagging index only hides a public repository, and an index that wrongly says public
// exposes nothing.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const anonymous = {};
const MEDIA = 'application/vnd.git-lfs+json';
const UNKNOWN = 'r00000000000000000000';

/** `target` with every authority and head-holder lookup recorded by name. */
function watching(target: Env) {
  const woken: string[] = [];
  const watched = (namespace: any) => ({
    ...namespace,
    idFromName: (name: string) => {
      woken.push(name);
      return namespace.idFromName(name);
    },
    get: (id: any) => namespace.get(id),
  });
  const env = {
    ...target,
    SOURCE_REPOS: watched(target.SOURCE_REPOS),
    LAND_COMBINERS: watched(target.LAND_COMBINERS),
    LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
    LFS_S3_BUCKET: 'yoneda-local-test',
    LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id',
    LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret',
  } as Env;
  return { env, woken };
}

async function raw(url: string, target: Env, init: RequestInit = {}) {
  const response = await platformFetch(new Request(`https://yoneda${url}`, init), target);
  return { status: response.status, challenge: response.headers.get('www-authenticate'), body: await response.text() };
}
const lfsDownload = (id: string, target: Env) =>
  raw(`/git/${id}.git/info/lfs/objects/batch`, target, {
    method: 'POST',
    headers: { accept: MEDIA, 'content-type': MEDIA },
    body: JSON.stringify({ operation: 'download', objects: [{ oid: 'a'.repeat(64), size: 3 }] }),
  });
const listed = (id: string, visibility: string) =>
  bindings.INDEX.prepare('UPDATE platform_repos SET visibility=? WHERE id=?').bind(visibility, id).run();

it('refuses an anonymous read of a private or unknown repository without waking it', async () => {
  const cookie = await signup('anon_owner');
  const make = async (name: string, visibility: string) =>
    (await api('/repos', { cookie }, { body: { name, visibility, files: [file('README.md', `# ${name}\n`)], author } })).body.id as string;
  const [open, closed] = [await make('open', 'public'), await make('closed', 'private')];
  // Today's answers, from the authority (signed-in strangers still ask it).
  const stranger = { cookie: await signup('anon_stranger') };
  const refused = (await api(`/repos/${closed}`, stranger)).body;
  expect(refused.error).toEqual({ code: 'NOT_FOUND', message: 'Repository not found' });

  const { env, woken } = watching(scoped);
  for (const id of [closed, UNKNOWN]) {
    for (const path of [`/repos/${id}`, `/repos/${id}/refs`, `/repos/${id}/blob?path=README.md`]) {
      const read = await api(path, anonymous, {}, env);
      expect([path, read.status, read.body.error]).toEqual([path, 404, refused.error]);
    }
    const objects = await api(`/repos/${id}/objects`, anonymous, { body: { objects: [{ id: 'a'.repeat(40), kind: 'blob' }] } }, env);
    expect(objects.status).toBe(404);
    const git = await raw(`/git/${id}.git/info/refs?service=git-upload-pack`, env);
    expect([git.status, git.challenge]).toEqual([401, 'Basic realm="YonedaRepo"']);
    expect((await lfsDownload(id, env)).status).toBe(401);
  }
  expect(woken.filter((name) => name.startsWith(closed) || name.startsWith(UNKNOWN))).toEqual([]);

  // A public repository is served as before.
  expect((await api(`/repos/${open}/blob?path=README.md`, anonymous, {}, env)).body.content).toBe('# open\n');
  expect((await raw(`/git/${open}.git/info/refs?service=git-upload-pack`, env)).status).toBe(200);
  expect((await lfsDownload(open, env)).status).toBe(200);
});

it('lets a lagging index hide a public repository but never expose a private one', async () => {
  const cookie = await signup('anon_lag_owner');
  const make = async (name: string, visibility: string) =>
    (await api('/repos', { cookie }, { body: { name, visibility, files: [file('a.md', 'a\n')], author } })).body.id as string;
  const [open, closed] = [await make('open', 'public'), await make('closed', 'private')];
  // The index has not caught up with a repository made public: it stays hidden meanwhile.
  await listed(open, 'private');
  expect((await api(`/repos/${open}`, anonymous)).status).toBe(404);
  await listed(open, 'public');
  expect((await api(`/repos/${open}`, anonymous)).status).toBe(200);
  // An index row saying public where the authority says private: the authority refuses.
  await listed(closed, 'public');
  const read = await api(`/repos/${closed}/blob?path=a.md`, anonymous);
  expect([read.status, read.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  expect((await raw(`/git/${closed}.git/info/refs?service=git-upload-pack`, scoped)).status).toBe(401);
  // Signed-in callers are never gated by the index (members of a private repository).
  await listed(closed, 'private');
  expect((await api(`/repos/${closed}`, { cookie })).status).toBe(200);
});
