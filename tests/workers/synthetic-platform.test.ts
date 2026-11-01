// The synthetic checks against the real platform: Superfan's requests have to be ones the
// platform answers. Only the health and page checks need the front Worker, which isn't in this
// fixture; tests/superfan/synthetic.test.ts covers them and what a pass does with its results.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { type Fetcher, type ProbeResult, runCheck } from '../../cloudflare/superfan/synthetic-checks';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const ORIGIN = 'https://yoneda';
const platform = (async (url: string, init: RequestInit) =>
  platformFetch(new Request(url, { ...init, signal: undefined }), scoped)) as unknown as Fetcher;
const pause = async () => {};

async function publicRepo(name: string) {
  const cookie = await signup('probe_owner');
  // What the probe repository's setup asks for: public, and nothing to clear before landing.
  const body = {
    name,
    visibility: 'public',
    policy: { required_checks: [], approvals: 0 },
    files: [file('README.md', 'probe\n')],
    author,
  };
  const created = await api('/repos', { cookie }, { body });
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  return { cookie, id };
}

const expectOk = (result: ProbeResult) => expect(result).toMatchObject({ ok: true, status: 200 });

it('clones a public repository with no credentials, and checks the pack', async () => {
  const { id } = await publicRepo('probe-clone');
  const targets = { front: ORIGIN, api: ORIGIN, cloneRepo: id };
  expectOk(await runCheck('clone', targets, pause, platform));
});

it('reads the public list through the API', async () => {
  await publicRepo('probe-list');
  expectOk(await runCheck('api', { front: ORIGIN, api: ORIGIN }, pause, platform));
});

it('lands with a repository token limited to the probe repository', async () => {
  const { cookie, id } = await publicRepo('probe-land');
  const minted = await api(`/repos/${id}/tokens`, { cookie }, {
    body: { name: 'probe', scopes: ['read', 'write', 'land'] },
  });
  expect(minted.status).toBe(200);
  const targets = { front: ORIGIN, api: ORIGIN, land: { repo: id, token: minted.body.token } };
  const before = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'];
  expectOk(await runCheck('land', targets, pause, platform));
  const after = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'];
  expect(after).not.toBe(before);
  // The next one lands on top of it: the same file, rewritten, never a conflict.
  expectOk(await runCheck('land', targets, pause, platform));
  expect((await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main']).not.toBe(after);
});

it('says so when the probe repository still needs an approval', async () => {
  const cookie = await signup('probe_gated');
  const body = { name: 'gated', policy: { approvals: 1, required_checks: [] }, files: [file('a', 'a')], author };
  const { id } = (await api('/repos', { cookie }, { body })).body;
  const { token } = (await api(`/repos/${id}/tokens`, { cookie }, { body: { name: 'p', scopes: ['read', 'write', 'land'] } })).body;
  const targets = { front: ORIGIN, api: ORIGIN, land: { repo: id, token } };
  expect(await runCheck('land', targets, pause, platform)).toMatchObject({
    ok: false,
    status: 409,
    detail: 'land: HTTP 409',
  });
});

it('fails a private repository as a refusal, without its answer', async () => {
  const cookie = await signup('probe_private');
  const created = await api('/repos', { cookie }, { body: { name: 'hidden', files: [file('a', 'a')], author } });
  const targets = { front: ORIGIN, api: ORIGIN, cloneRepo: created.body.id as string };
  expect(await runCheck('clone', targets, pause, platform)).toMatchObject({
    ok: false,
    status: 401,
    detail: 'refs: HTTP 401',
  });
});
