// Symbol-level read and write sets: the platform derives which symbols a commit wrote,
// a reader of other symbols in the same file lands through a three-way merge, a reader
// of a written symbol conflicts, and unparseable files fall back to whole-file writes.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const LIB = 'pub fn retry() -> u32 {\n    1\n}\n\npub fn backoff() -> u32 {\n    2\n}\n';
const BROKEN = 'pub fn retry() -> u32 {\n    1\n}\n\npub fn backoff() -> u32 {\n    2\n';

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const policy = { required_checks: [], approvals: 0 };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('src/lib.rs', LIB), file('src/broken.rs', BROKEN)], author } });
  const repo = `/repos/${created.body.id}`;
  const agent = async (who: string) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name: who, scopes: ['read', 'write', 'land'] } })).body.token as string });
  const work = async (who: { token: string }, path: string, text: string, read_set: string[]) =>
    (await api(`${repo}/commits`, who, { body: { parent: created.body.commit, base_version: 1, changes: [file(path, text)], message: `edit ${path}`, author, read_set } })).body;
  const land = (who: { token: string }, commit: string) => api(`${repo}/land`, who, { body: { ref: 'main', commit } });
  return { repo, agent, work, land };
}

it('lands edits to different functions of one file when each reads only its own symbols', async () => {
  const { repo, agent, work, land } = await setup('symbolsets');
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(agent));
  const retry = await work(a, 'src/lib.rs', LIB.replace('    1\n', '    10\n'), ['src/lib.rs#retry']);
  const backoff = await work(b, 'src/lib.rs', LIB.replace('    2\n', '    20\n'), ['src/lib.rs#backoff']);
  const readsRetry = await work(c, 'README.md', 'uses retry\n', ['src/lib.rs#retry']);
  expect((await api(`${repo}/commits/${retry.commit}`, a)).body.symbol_touches).toEqual([{ path: 'src/lib.rs', symbols: ['retry'] }]);

  expect((await land(a, retry.commit)).body.landed).toBe(true);
  const merged = await land(b, backoff.commit);
  expect(merged.status).toBe(200);
  expect(merged.body.merged).toBe(backoff.commit);
  expect((await api(`${repo}/blob?path=src/lib.rs`, a)).body.content).toBe(LIB.replace('    1\n', '    10\n').replace('    2\n', '    20\n'));

  // A reader of the symbol that changed must reconcile.
  const stale = await land(c, readsRetry.commit);
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('CONFLICT');
  expect(stale.body.error.message).toContain('src/lib.rs#retry');
});

it('treats changes to an unparseable file as whole-file writes', async () => {
  const { repo, agent, work, land } = await setup('symbolfallback');
  const [a, b] = await Promise.all(['a', 'b'].map(agent));
  const edit = await work(a, 'src/broken.rs', BROKEN.replace('    1\n', '    10\n'), []);
  const readsOther = await work(b, 'README.md', 'uses backoff\n', ['src/broken.rs#backoff']);
  expect((await api(`${repo}/commits/${edit.commit}`, a)).body.symbol_touches).toEqual([]);
  expect((await land(a, edit.commit)).body.landed).toBe(true);
  const stale = await land(b, readsOther.commit);
  expect(stale.body.error.code).toBe('CONFLICT');
  expect(stale.body.error.message).toContain('src/broken.rs#backoff');
});
