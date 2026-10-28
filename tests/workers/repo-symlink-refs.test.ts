// A symlink placed by blob id gets the same target check as one sent as content: the
// commit adapter answers the authority's request for the blob's bytes, and an escaping
// target is refused while one inside the repository commits.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function blobId(text: string) {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const sha1 = await crypto.subtle.digest('SHA-1', new Uint8Array([...header, ...body]));
  return [...new Uint8Array(sha1)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

it('checks the target of a symlink referenced by blob id', async () => {
  const owner = { cookie: await signup('linker') };
  const files = [file('README.md', '# r\n'), file('escape.txt', '../../etc/passwd'), file('inside.txt', 'README.md')];
  const created = await api('/repos', owner, { body: { name: 'links', files, author } });
  const repo = `/repos/${created.body.id}`;
  const link = async (path: string, target: string) =>
    api(`${repo}/commits`, owner, {
      body: {
        ref: 'main',
        message: `link ${path}`,
        author,
        changes: [{ path, blob: await blobId(target), type: 'symlink' }],
      },
    });
  const refused = await link('evil', '../../etc/passwd');
  expect([refused.status, refused.body.error?.code]).toEqual([400, 'UNSAFE_PATH']);
  const made = await link('readme', 'README.md');
  expect(made.status).toBe(200);
  expect(made.body.commit).toMatch(/^[0-9a-f]{40}$/);
});
