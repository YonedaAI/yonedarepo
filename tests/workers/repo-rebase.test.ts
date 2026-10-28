// Server-side rebase through the public API: a branch behind main replays onto main's head
// as linear history moved by one compare-and-swap; a conflict names its paths and leaves
// the branch where it was.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const NOTES = 'a\nb\nc\nd\ne\n';

it('rebases a branch onto main, refuses conflicts and protected branches', async () => {
  const owner = { cookie: await signup('rebaser') };
  const created = await api('/repos', owner, {
    body: { name: 'rb', policy: { required_checks: [], approvals: 0 }, files: [file('notes.txt', NOTES), file('b.txt', 'b\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const root = created.body.commit as string;
  const make = async (parent: string, path: string, text: string, message: string) =>
    (await api(`${repo}/commits`, owner, { body: { parent, base_version: 1, changes: [file(path, text)], message, author } })).body.commit as string;
  const branch = (ref: string, commit: string) => api(`${repo}/branches`, owner, { body: { ref, commit, expected: null } });
  const refs = async () => (await api(`${repo}/refs`, owner)).body.refs;

  const one = await make(root, 'notes.txt', NOTES.replace('a\n', 'A\n'), 'Capitalize a\n');
  const two = await make(one, 'c.txt', 'c\n', 'Add c\n');
  expect((await branch('topic/feature', two)).status).toBe(200);
  const clash = await make(root, 'b.txt', 'mine\n', 'Mine\n');
  expect((await branch('clash', clash)).status).toBe(200);
  // Main moves on: line 5 of notes (merges cleanly with the branch) and b.txt (conflicts).
  const moved = await api(`${repo}/commits`, owner, {
    body: { ref: 'main', changes: [file('notes.txt', NOTES.replace('e\n', 'E\n')), file('b.txt', 'theirs\n')], message: 'main', author },
  });
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: moved.body.commit } })).body.landed).toBe(true);
  const main = (await refs())['refs/heads/main'];

  const rebased = await api(`${repo}/branches/topic/feature/rebase`, owner, { body: {} });
  expect(rebased.status).toBe(200);
  expect(rebased.body).toMatchObject({ ref: 'refs/heads/topic/feature', before: two, onto: 'refs/heads/main' });
  expect(rebased.body.commits.map((c: any) => c.from)).toEqual([one, two]);
  const head = rebased.body.head as string;
  expect((await refs())['refs/heads/topic/feature']).toBe(head);
  const log = await api(`${repo}/log?ref=topic/feature&limit=3`, owner);
  expect(log.body.commits.map((c: any) => c.commit)).toEqual([head, rebased.body.commits[0].to, main]);
  const top = await api(`${repo}/commits/${head}`, owner);
  expect([top.body.parents.length, top.body.message]).toEqual([1, 'Add c\n']);
  expect((await api(`${repo}/blob?path=notes.txt&commit=${head}`, owner)).body.content).toBe('A\nb\nc\nd\nE\n');
  // Again: nothing to replay.
  const again = await api(`${repo}/branches/topic%2Ffeature/rebase`, owner, { body: {} });
  expect(again.body).toMatchObject({ up_to_date: true, head });

  const refused = await api(`${repo}/branches/clash/rebase`, owner, { body: { onto: 'main' } });
  expect([refused.status, refused.body.error.code]).toEqual([409, 'CONFLICT']);
  const [conflict] = refused.body.error.details.conflicts;
  expect(conflict).toMatchObject({ path: 'b.txt', kind: 'content' });
  for (const side of [conflict.base, conflict.ours, conflict.theirs]) expect(side).toMatch(/^[0-9a-f]{40}$/);
  expect(refused.body.error.details.commit).toBe(clash);
  expect((await refs())['refs/heads/clash']).toBe(clash);

  expect((await api(`${repo}/branches/main/rebase`, owner, { body: {} })).status).toBe(403);
});
