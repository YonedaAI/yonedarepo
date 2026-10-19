// Server-side history operations: revert and cherry-pick create commits on the server
// from existing objects, with conflicts detected instead of silent overwrites.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function repoWith(owner: { cookie: string }) {
  const created = await api('/repos', owner, {
    body: { name: 'history', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', 'one\n'), file('b.txt', 'b\n')], author },
  });
  return `/repos/${created.body.id}`;
}

it('reverts and cherry-picks on the server and refuses to clobber moved paths', async () => {
  const owner = { cookie: await signup('historian') };
  const repo = await repoWith(owner);
  const commit = async (changes: unknown[], message: string, ref = 'main') => {
    const made = await api(`${repo}/commits`, owner, { body: { ref, changes, message, author } });
    expect(made.status).toBe(200);
    return made.body.commit as string;
  };
  const land = async (sha: string, ref = 'main') =>
    expect((await api(`${repo}/land`, owner, { body: { ref, commit: sha } })).body.landed).toBe(true);

  const edit = await commit([file('a.txt', 'two\n'), file('c.txt', 'new\n')], 'Edit a, add c');
  await land(edit);
  const reverted = await api(`${repo}/commits/${edit}/revert`, owner, { body: {} });
  expect(reverted.status).toBe(200);
  expect(reverted.body.touches.map((t: any) => `${t.op}:${t.path}`).sort()).toEqual(['delete:c.txt', 'modify:a.txt']);
  const shown = await api(`${repo}/commits/${reverted.body.commit}`, owner);
  expect(shown.body.message).toBe(`Revert "Edit a, add c"\n\nThis reverts commit ${edit}.`);
  await land(reverted.body.commit);
  expect((await api(`${repo}/blob?path=a.txt`, owner)).body.content).toBe('one\n');
  expect((await api(`${repo}/blob?path=c.txt`, owner)).status).toBe(404);

  // Cherry-pick the original edit back onto a fresh branch head.
  const picked = await api(`${repo}/commits/${edit}/cherry-pick`, owner, { body: { ref: 'main' } });
  expect(picked.status).toBe(200);
  expect(picked.body.parents).toEqual([reverted.body.commit]);
  await land(picked.body.commit);
  expect((await api(`${repo}/blob?path=c.txt`, owner)).body.content).toBe('new\n');

  // Reverting the first revert again after a.txt moved on is a conflict.
  await land(await commit([file('a.txt', 'three\n')], 'Move a on'));
  const conflict = await api(`${repo}/commits/${reverted.body.commit}/revert`, owner, { body: {} });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error).toMatchObject({ code: 'CONFLICT' });
  expect(conflict.body.error.message).toContain('a.txt');
});
