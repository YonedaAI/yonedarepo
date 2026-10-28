// Annotated tags and releases end to end in workerd: a pushed tag object is verified and
// kept (a malformed one moves nothing), advertised with its peeled commit (protocol 0 and
// 2) and sent to a fetch that wants it; `git_tag` with a message builds one. A release is
// published only with write and land, and its asset's bytes round-trip through R2 with
// the recorded sha256.
import { expect, it, vi } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const text = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function tagObject(body: string) {
  const data = text.encode(body);
  const id = hex(await crypto.subtle.digest('SHA-1', new Uint8Array([...text.encode(`tag ${data.length}\0`), ...data])));
  return { id, kind: 'tag', data_b64: b64(data) };
}

async function git(path: string, token: string, method = 'GET', body?: BodyInit, headers: Record<string, string> = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${path}`, {
      method,
      headers: { ...headers, authorization: `Basic ${btoa(`git:${token}`)}` },
      body,
    }),
    scoped,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, text: new TextDecoder('latin1').decode(bytes), bytes };
}

/** Pushes `objects` (the first is the new value) to `refname` over receive-pack. */
async function push(repo: string, token: string, refname: string, objects: Json[]) {
  const { push_b64 } = compute({ op: 'branch_push', refname, old: null, new: objects[0].id, objects });
  const body = Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0));
  return (await git(`${repo}.git/git-receive-pack`, token, 'POST', body)).text;
}
type Json = Record<string, any>;

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const v2 = (name: string, args: string[]) =>
  `${pkt(`command=${name}\n`)}${pkt('object-format=sha1\n')}0001${args.map((a) => pkt(`${a}\n`)).join('')}0000`;
const packCount = (answer: string) => {
  const at = answer.indexOf('PACK');
  expect(at).toBeGreaterThan(0);
  return [...answer.slice(at + 8, at + 12)].reduce((n, c) => n * 256 + c.charCodeAt(0), 0);
};

async function setup(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const mint = async (scopes: string[]) =>
    (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: scopes.join('-'), scopes } })).body.token as string;
  const refs = async () => (await api(`/repos/${repo}/refs`, { cookie })).body;
  return { repo, cookie, mint, refs, main: (await refs()).refs['refs/heads/main'] as string };
}

it('accepts an annotated tag push, advertises it peeled and sends the tag object to a fetch', async () => {
  const { repo, mint, refs, main } = await setup('annotated_push');
  const token = await mint(['read', 'write', 'land']);
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const tag = await tagObject(`object ${main}\ntype commit\ntag v1\ntagger ${who}\n\nx\n`);

  // A malformed tag object (no tag header) is refused; nothing moves.
  const bad = await tagObject(`object ${main}\ntype commit\ntagger ${who}\n\nx\n`);
  const refused = await push(repo, token, 'refs/tags/bad', [bad]);
  expect(refused).toContain('ng refs/tags/bad invalid tag object');
  expect((await refs()).refs['refs/tags/bad']).toBeUndefined();

  expect(await push(repo, token, 'refs/tags/v1', [tag])).toContain('ok refs/tags/v1');
  const listed = await refs();
  expect(listed.refs['refs/tags/v1']).toBe(main);
  expect(listed.annotated).toEqual({ 'refs/tags/v1': tag.id });

  // Protocol 0: the tag object, then its peeled commit.
  const advertised = await git(`${repo}.git/info/refs?service=git-upload-pack`, token);
  expect(advertised.text).toContain(`${tag.id} refs/tags/v1\n`);
  expect(advertised.text).toContain(`${main} refs/tags/v1^{}\n`);
  // Protocol 2: `peeled:` when asked.
  const upload = (body: string) =>
    git(`${repo}.git/git-upload-pack`, token, 'POST', body, { 'git-protocol': 'version=2' });
  const lsRefs = await upload(v2('ls-refs', ['peel', 'ref-prefix refs/tags/']));
  expect(lsRefs.text).toContain(`${tag.id} refs/tags/v1 peeled:${main}\n`);
  // Wanting the tag sends its commit's history plus the tag object: one more than main.
  const fetch = (want: string) => upload(v2('fetch', [`want ${want}`, 'done']));
  const byMain = packCount((await fetch(main)).text);
  expect(packCount((await fetch(tag.id)).text)).toBe(byMain + 1);
});

it('builds annotated tags server-side and publishes releases with assets only with land', async () => {
  const { repo, cookie, mint, refs, main } = await setup('releases_rest');
  const owner = { cookie };
  const made = await api(`/repos/${repo}/tags`, owner, { body: { name: 'v1', commit: main, message: 'First cut' } });
  expect(made.status).toBe(200);
  expect((await refs()).annotated['refs/tags/v1']).toBe(made.body.tag);

  const reader = await mint(['read']);
  const writer = await mint(['read', 'write']);
  const release = { tag: 'v1', title: 'First', notes: 'Notes here.' };
  for (const token of [reader, writer]) {
    const denied = await api(`/repos/${repo}/releases`, { token }, { body: release });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'FORBIDDEN']);
  }
  const created = await api(`/repos/${repo}/releases`, owner, { body: release });
  expect([created.status, created.body.tag, created.body.commit_id]).toEqual([200, 'v1', main]);

  const bytes = text.encode('release asset bytes\n'.repeat(100));
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const put = (auth: Record<string, string>) =>
    platformFetch(
      new Request(`https://yoneda/api/v1/repos/${repo}/releases/v1/assets/app.tar`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/x-tar' },
        body: bytes,
      }),
      scoped,
    );
  expect((await put({ authorization: `Bearer ${writer}` })).status).toBe(403);
  const uploaded = await put({ cookie });
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toMatchObject({ name: 'app.tar', size: bytes.length, sha256 });
  expect((await put({ cookie })).status).toBe(409);
  const key = `platform/v1/${repo}/release/v1/${sha256}/app.tar`;
  expect((await scoped.OBJECTS.head(key))?.size).toBe(bytes.length);

  // A read-only token downloads the same bytes with the recorded sha256.
  const download = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/releases/v1/assets/app.tar`, {
      headers: { authorization: `Bearer ${reader}` },
    }),
    scoped,
  );
  expect([download.status, download.headers.get('x-yoneda-sha256')]).toEqual([200, sha256]);
  expect(hex(await crypto.subtle.digest('SHA-256', await download.arrayBuffer()))).toBe(sha256);

  const shown = await api(`/repos/${repo}/releases/v1`, { token: reader });
  expect(shown.body.assets).toMatchObject([{ name: 'app.tar', sha256 }]);
  expect(shown.body.annotated.message).toBe('First cut\n');
  expect((await api(`/repos/${repo}/releases`, { token: reader })).body.releases).toHaveLength(1);

  const deleted = await api(`/repos/${repo}/releases/v1`, owner, { method: 'DELETE' });
  expect(deleted.body.assets).toEqual([{ name: 'app.tar', sha256 }]);
  expect(await scoped.OBJECTS.head(key)).toBeNull();
  expect((await api(`/repos/${repo}/releases`, owner)).body.releases).toEqual([]);
});

it('keeps one upload whole when two first uploads of a name race', async () => {
  const { repo, cookie, main } = await setup('releases_race');
  await api(`/repos/${repo}/tags`, { cookie }, { body: { name: 'v1', commit: main } });
  await api(`/repos/${repo}/releases`, { cookie }, { body: { tag: 'v1', title: 'Race' } });
  const url = `https://yoneda/api/v1/repos/${repo}/releases/v1/assets/same.bin`;
  const put = (body: Uint8Array) =>
    platformFetch(new Request(url, { method: 'PUT', headers: { cookie }, body }), scoped);
  // A's bytes reach R2 only after B has written and recorded its own.
  const [a, b] = [text.encode('upload A\n'), text.encode('upload B, longer\n')];
  let releaseA = () => {};
  const held = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const write = scoped.OBJECTS.put.bind(scoped.OBJECTS);
  const puts = vi.spyOn(scoped.OBJECTS, 'put').mockImplementation(async (key, value, options) => {
    if (key.includes('/release/') && puts.mock.calls.length === 1) await held;
    return write(key, value, options);
  });
  try {
    const first = put(a);
    await vi.waitFor(() => expect(puts).toHaveBeenCalledTimes(1));
    const second = await put(b);
    releaseA();
    const statuses = [(await first).status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  } finally {
    puts.mockRestore();
  }
  const download = await platformFetch(new Request(url, { headers: { cookie } }), scoped);
  const bytes = await download.arrayBuffer();
  // The bytes served are the bytes recorded: B's.
  expect(download.headers.get('x-yoneda-sha256')).toBe(hex(await crypto.subtle.digest('SHA-256', b)));
  expect(hex(await crypto.subtle.digest('SHA-256', bytes))).toBe(download.headers.get('x-yoneda-sha256'));
  // A's bytes are gone; only the recorded upload is stored.
  const stored = await scoped.OBJECTS.list({ prefix: `platform/v1/${repo}/release/` });
  expect(stored.objects).toHaveLength(1);
});
