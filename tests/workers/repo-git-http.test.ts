// Git over HTTPS access: credentials as Git sends them (a token as the Basic password,
// asked for with a 401) and the authority's verdict per service: read to fetch, write to
// push, never a path-restricted grant, and a personal token only on its allowlist. Tags
// are created once over REST and advertised to Git.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const basic = (password: string) => `Basic ${btoa(`git:${password}`)}`;

async function git(
  path: string,
  authorization?: string,
  method = 'GET',
  body: BodyInit = '0000',
  headers: Record<string, string> = {},
) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${path}`, {
      method,
      headers: { ...headers, ...(authorization ? { authorization } : {}) },
      body: method === 'POST' ? body : undefined,
    }),
    scoped,
  );
  return {
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
    type: response.headers.get('content-type'),
    text: new TextDecoder().decode(await response.arrayBuffer()),
  };
}

async function repo(cookie: string, name: string) {
  const created = await api('/repos', { cookie }, { body: { name, files: [file('docs/a.md', 'a\n')], author } });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

async function token(cookie: string, id: string, name: string, scopes: string[], paths?: string[]) {
  const minted = await api(`/repos/${id}/tokens`, { cookie }, { body: { name, scopes, paths } });
  expect(minted.status).toBe(200);
  return minted.body.token as string;
}

it('asks Git for credentials and holds each token to its service, grant and allowlist', async () => {
  const cookie = await signup('git_http_owner');
  const [a, b] = [await repo(cookie, 'alpha'), await repo(cookie, 'beta')];
  const upload = (id: string) => `${id}.git/info/refs?service=git-upload-pack`;
  const receive = (id: string) => `${id}.git/info/refs?service=git-receive-pack`;

  const anonymous = await git(upload(a));
  expect([anonymous.status, anonymous.challenge]).toEqual([401, 'Basic realm="YonedaRepo"']);
  expect((await git(upload(a), basic('a password'))).status).toBe(401);

  const reader = await token(cookie, a, 'reader', ['read']);
  const fetched = await git(upload(a), basic(reader));
  expect([fetched.status, fetched.type]).toEqual([200, 'application/x-git-upload-pack-advertisement']);
  expect(fetched.text).toContain('symref=HEAD:refs/heads/main');
  const main = (await api(`/repos/${a}/refs`, { cookie })).body.refs['refs/heads/main'];
  expect(fetched.text).toContain(`${main} refs/heads/main`);
  const refused = await git(receive(a), basic(reader));
  expect([refused.status, refused.text]).toEqual([403, 'FORBIDDEN: Token lacks the write scope\n']);
  expect((await git(`${a}.git/git-receive-pack`, basic(reader), 'POST')).status).toBe(403);

  // A push lists main only as `.have`: it lands, so Git must not refuse it as
  // non-fast-forward, and must not resend main's history either.
  const writer = await token(cookie, a, 'writer', ['read', 'write']);
  const pushing = await git(receive(a), basic(writer));
  expect([pushing.status, pushing.type]).toEqual([200, 'application/x-git-receive-pack-advertisement']);
  expect(pushing.text).toContain('report-status delete-refs atomic ofs-delta no-thin');
  expect(pushing.text).toContain(`${main} .have\0`);
  expect(pushing.text).not.toContain('refs/heads/main');
  // Git's probe before a large push: an empty command list, answered empty.
  const probe = await git(`${a}.git/git-receive-pack`, basic(writer), 'POST');
  expect([probe.status, probe.text]).toEqual([200, '']);

  const docs = await token(cookie, a, 'docs', ['read'], ['docs/']);
  const restricted = await git(upload(a), basic(docs));
  expect(restricted.status).toBe(403);
  expect(restricted.text).toContain('path-restricted');

  const pat = await api('/tokens', { cookie }, { body: { name: 'laptop', scopes: ['repo:read'], repos: [a] } });
  expect((await git(upload(a), basic(pat.body.token))).status).toBe(200);
  expect((await git(upload(a), `Bearer ${pat.body.token}`)).status).toBe(200);
  const outside = await git(upload(b), basic(pat.body.token));
  expect([outside.status, outside.text]).toEqual([403, 'FORBIDDEN: This token is not allowed on this repository\n']);
  expect((await git(receive(a), basic(pat.body.token))).status).toBe(403);

  // A clone's request, gzipped as Git sends larger ones: NAK, then the pack on side-band 1.
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
  const wants = `${pkt(`want ${main} multi_ack_detailed side-band-64k\n`)}0000${pkt('done\n')}`;
  const gzipped = await new Response(
    new Blob([wants]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const cloned = await git(`${a}.git/git-upload-pack`, basic(reader), 'POST', gzipped, {
    'content-encoding': 'gzip',
  });
  expect([cloned.status, cloned.type]).toEqual([200, 'application/x-git-upload-pack-result']);
  expect(cloned.text.startsWith('0008NAK\n')).toBe(true);
  expect(cloned.text.slice(8, 13)).toMatch(/^[0-9a-f]{4}\x01$/);
  expect(cloned.text.slice(13, 17)).toBe('PACK');
  expect(cloned.text.endsWith('0000')).toBe(true);

  expect((await git(`${a}.git/info/refs`, basic(reader))).status).toBe(403);
  expect((await git('nope.git/info/refs?service=git-upload-pack', basic(reader))).status).toBe(404);
});

it('creates lightweight tags over REST, lists and advertises them, and never moves them', async () => {
  const cookie = await signup('tagger');
  const id = await repo(cookie, 'tagged');
  const owner = { cookie };
  const { refs } = (await api(`/repos/${id}/refs`, owner)).body;
  const main = refs['refs/heads/main'];
  queued.length = 0;
  const made = await api(`/repos/${id}/tags`, owner, { body: { name: 'v1', commit: main } });
  expect(made.status).toBe(200);
  expect(made.body).toMatchObject({ ref: 'refs/tags/v1', commit: main });
  expect(queued.some((m) => m.kind === 'platform_project')).toBe(true); // mirrored like main
  expect((await api(`/repos/${id}/refs`, owner)).body.refs['refs/tags/v1']).toBe(main);
  expect((await api(`/repos/${id}/tags`, owner, { body: { name: 'v1', commit: main } })).body.already).toBe(true);

  const changed = await api(`/repos/${id}/commits`, owner, {
    body: { ref: 'main', changes: [file('docs/b.md', 'b\n')], message: 'b', author },
  });
  const moved = await api(`/repos/${id}/tags`, owner, { body: { name: 'v1', commit: changed.body.commit } });
  expect(moved.body.error.code).toBe('ALREADY_EXISTS');

  const write = (await api(`/repos/${id}/tokens`, owner, { body: { name: 'w', scopes: ['read', 'write'] } })).body.token;
  const denied = await api(`/repos/${id}/tags`, { token: write }, { body: { name: 'v2', commit: main } });
  expect([denied.status, denied.body.error.code]).toEqual([403, 'FORBIDDEN']);

  const advertised = await git(`${id}.git/info/refs?service=git-upload-pack`, basic(write));
  expect(advertised.text).toContain(`${main} refs/tags/v1\n`);
});
