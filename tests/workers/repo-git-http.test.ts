// Git over HTTPS access: credentials as Git sends them (a token as the Basic password,
// asked for with a 401) and the authority's verdict per service: read to fetch, write to
// push, never a path-restricted grant, and a personal token only on its allowlist. Tags
// are created once over REST and advertised to Git. Protocol version 2 serves ls-refs and
// partial, shallow and negotiated fetches; version 0 stays as it was.
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
    type: response.headers.get('content-type'),
    text: new TextDecoder().decode(bytes),
    bytes,
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

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const v2 = { 'git-protocol': 'version=2' };
const command = (name: string, args: string[]) =>
  `${pkt(`command=${name}\n`)}${pkt('agent=git/2.47.0\n')}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;

/** Objects in the pack that follows `PACK` in a side-band answer (the header's count). */
function packCount(bytes: Uint8Array) {
  const at = new TextDecoder('latin1').decode(bytes).indexOf('PACK');
  expect(at).toBeGreaterThan(0);
  return new DataView(bytes.buffer, bytes.byteOffset + at + 8, 4).getUint32(0);
}

async function blobId(text: string) {
  const content = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...header, ...content]));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

it('serves protocol v2: ls-refs, partial and shallow fetches, blobs by id, negotiation', async () => {
  const cookie = await signup('git_v2_owner');
  const created = await api('/repos', { cookie }, {
    body: { name: 'big', policy: { required_checks: [], approvals: 0 }, files: [file('docs/a.md', 'a\n')], author },
  });
  const id = created.body.id as string;
  for (const name of ['b', 'c']) {
    const made = await api(`/repos/${id}/commits`, { cookie }, {
      body: { ref: 'main', changes: [file(`docs/${name}.md`, `${name}\n`)], message: name, author },
    });
    const landed = await api(`/repos/${id}/land`, { cookie }, { body: { ref: 'main', commit: made.body.commit } });
    expect(landed.body.landed).toBe(true);
  }
  expect((await api(`/repos/${id}/log?ref=main&limit=5`, { cookie })).body.commits).toHaveLength(3);
  const main = (await api(`/repos/${id}/refs`, { cookie })).body.refs['refs/heads/main'];
  const reader = basic(await token(cookie, id, 'reader', ['read']));
  const post = (body: string) => git(`${id}.git/git-upload-pack`, reader, 'POST', body, v2);

  const caps = await git(`${id}.git/info/refs?service=git-upload-pack`, reader, 'GET', '', v2);
  expect([caps.status, caps.type]).toEqual([200, 'application/x-git-upload-pack-advertisement']);
  expect(caps.text.startsWith('000eversion 2\n')).toBe(true);
  expect(caps.text).toContain('fetch=shallow filter\n');
  // Without the header (and for pushes) nothing changes.
  const v0 = await git(`${id}.git/info/refs?service=git-upload-pack`, reader);
  expect(v0.text.startsWith('001e# service=git-upload-pack\n0000')).toBe(true);

  const listed = await post(command('ls-refs', ['symrefs', 'peel', 'ref-prefix HEAD', 'ref-prefix refs/heads/']));
  expect(listed.text).toContain(`${main} HEAD symref-target:refs/heads/main\n`);
  expect(listed.text).toContain(`${main} refs/heads/main\n`);
  expect(listed.text.endsWith('0000')).toBe(true);

  // `git clone --depth 1 --filter=blob:none`: the tip, shallow, with its trees and no blob.
  const shallow = await post(command('fetch', [`want ${main}`, 'deepen 1', 'filter blob:none', 'ofs-delta', 'done']));
  expect(shallow.text.startsWith(`0011shallow-info\n0035shallow ${main}\n0001000dpackfile\n`)).toBe(true);
  expect(packCount(shallow.bytes)).toBe(3); // the commit, its root tree and docs/
  expect(shallow.text.endsWith('0000')).toBe(true);
  // The whole history: a partial clone leaves out exactly the three files.
  const full = packCount((await post(command('fetch', [`want ${main}`, 'done']))).bytes);
  const partial = packCount((await post(command('fetch', [`want ${main}`, 'filter blob:none', 'done']))).bytes);
  expect(full - partial).toBe(3);
  // A checkout's lazy fetch: one blob by id.
  const lazy = await post(command('fetch', [`want ${await blobId('b\n')}`, 'filter blob:none', 'done']));
  expect(lazy.text.startsWith('000dpackfile\n')).toBe(true);
  expect(packCount(lazy.bytes)).toBe(1);
  // Negotiation: nothing in common is NAK; a common have is acknowledged, then ready.
  const nak = await post(command('fetch', [`want ${main}`, `have ${'e'.repeat(40)}`]));
  expect(nak.text).toBe('0014acknowledgments\n0008NAK\n0000');
  const ready = await post(command('fetch', [`want ${main}`, `have ${main}`]));
  expect(ready.text.startsWith(`0014acknowledgments\n0031ACK ${main}\n000aready\n0001000dpackfile\n`)).toBe(true);
  expect(packCount(ready.bytes)).toBe(0);
  // What is not served is an ERR line Git prints as `remote error: …`.
  const refused = await post(command('fetch', [`want ${main}`, 'filter tree:0', 'done']));
  expect(refused.status).toBe(200);
  expect(refused.text).toMatch(/^[0-9a-f]{4}ERR GIT_OBJECT_INVALID: Filter "tree:0" is not served/);
});
