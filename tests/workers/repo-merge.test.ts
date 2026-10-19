// N3 exit gate: concurrent work on one file merges on the server when hunks are disjoint;
// overlapping hunks and stale reads come back as conflicts to reconcile.
import { expect, it } from 'vitest';
import { api, author, file, queued, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const BASE = 'fn a() {\n    1\n}\n\nfn b() {\n    2\n}\n\nfn c() {\n    3\n}\n';

it('lands disjoint edits to one file as a platform merge and rejects overlaps', async () => {
  const owner = { cookie: await signup('merger') };
  const policy = { required_checks: [], approvals: 0, runners: { unit: { command: ['true'] } } };
  const created = await api('/repos', owner, { body: { name: 'm', policy, files: [file('src/lib.rs', BASE), file('README.md', 'r\n')], author } });
  const repo = `/repos/${created.body.id}`;
  const token = async (name: string) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name, scopes: ['read', 'write', 'land'] } })).body.token as string });
  const [one, two, three, four] = await Promise.all(['one', 'two', 'three', 'four'].map(token));
  const work = (who: { token: string }, text: string, read_set: string[] = [], path = 'src/lib.rs') =>
    api(`${repo}/commits`, who, { body: { ref: 'main', changes: [file(path, text)], message: `edit by ${path}`, author, read_set } });

  // All four start from the same head.
  const a = await work(one, BASE.replace('    1\n', '    10\n'));
  const c = await work(two, BASE.replace('    3\n', '    30\n'));
  const clash = await work(three, BASE.replace('    1\n', '    100\n'));
  const stale = await work(four, 'readme v2\n', ['src/'], 'README.md');
  // Check runs gate landing? No: approvals 0 and no required checks; runners still run.
  expect((await api(`${repo}/land`, one, { body: { ref: 'main', commit: a.body.commit } })).body.version).toBe(2);
  const merged = await api(`${repo}/land`, two, { body: { ref: 'main', commit: c.body.commit } });
  expect(merged.status).toBe(200);
  expect(merged.body).toMatchObject({ version: 3, merged: c.body.commit });
  const content = await api(`${repo}/blob?path=src/lib.rs`, one);
  expect(content.body.content).toBe(BASE.replace('    1\n', '    10\n').replace('    3\n', '    30\n'));
  const mergeCommit = await api(`${repo}/commits/${merged.body.merge}`, one);
  expect(mergeCommit.body).toMatchObject({ parents: [a.body.commit, c.body.commit], principal: 'platform:merge' });
  // Post-land checks: the merge commit's own runs were queued.
  expect(mergeCommit.body.check_runs.map((r: any) => r.name)).toEqual(['unit']);
  expect(queued.some((m) => m.kind === 'platform_check')).toBe(true);
  const kinds = (await api(`${repo}/txlog`, one)).body.entries.map((e: any) => e.kind);
  expect(kinds).toEqual(['import', 'commit', 'merge']);

  const conflict = await api(`${repo}/land`, three, { body: { ref: 'main', commit: clash.body.commit } });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe('CONFLICT');
  expect(conflict.body.error.details.conflicts[0]).toMatchObject({ path: 'src/lib.rs', kind: 'content' });
  expect(conflict.body.error.details.conflicts[0].marked).toContain('<<<<<<< ours\n    10\n||||||| base\n    1\n=======\n    100\n>>>>>>> theirs\n');

  const staleRead = await api(`${repo}/land`, four, { body: { ref: 'main', commit: stale.body.commit } });
  expect(staleRead.body.error.code).toBe('CONFLICT');
  expect(staleRead.body.error.message).toContain('src/');
});

it('creates explicit merge commits of branches', async () => {
  const owner = { cookie: await signup('brancher') };
  const created = await api('/repos', owner, { body: { name: 'b', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'a\n'), file('b.txt', 'b\n')], author } });
  const repo = `/repos/${created.body.id}`;
  const feature = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'feature b\n')], message: 'feature', author } });
  expect((await api(`${repo}/land`, owner, { body: { ref: 'feature', commit: feature.body.commit } })).body.landed).toBe(true);
  expect((await api(`${repo}/merges`, owner, { body: { source: 'feature', into: 'main' } })).body.fast_forward).toBe(feature.body.commit);
  const mainEdit = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', 'main a\n')], message: 'main', author } });
  await api(`${repo}/land`, owner, { body: { ref: 'main', commit: mainEdit.body.commit } });
  const merge = await api(`${repo}/merges`, owner, { body: { source: 'feature', into: 'main' } });
  expect(merge.status).toBe(200);
  expect(merge.body.parents).toEqual([mainEdit.body.commit, feature.body.commit]);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: merge.body.commit } })).body.landed).toBe(true);
  expect((await api(`${repo}/blob?path=b.txt`, owner)).body.content).toBe('feature b\n');
  expect((await api(`${repo}/merges`, owner, { body: { source: 'feature', into: 'main' } })).body.up_to_date).toBe(true);
});
