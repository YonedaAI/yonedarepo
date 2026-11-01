// Through the real authority (workerd): a repository without the flight plans table refuses a
// filing and reads as before, and a go-around reaches a new session through `git_context` and
// `change show`, with file and line.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.md', 'a\n')], author },
  });
  const repo = `/repos/${created.body.id}`;
  const commit = await api(`${repo}/commits`, owner, {
    body: { ref: 'main', changes: [file('b.md', 'b\n')], message: 'b', author },
  });
  await api(`${repo}/branches`, owner, { body: { ref: 'fix', commit: commit.body.commit, expected: null } });
  const change = await api(`${repo}/changes`, owner, { body: { branch: 'fix', title: 'Fix it' } });
  return { owner, repo, number: change.body.number as number, head: commit.body.commit as string };
}

it('refuses a filing cleanly while the repository has no plans, and the change still reads', async () => {
  const { owner, repo, number } = await setup('plans');
  const filed = await api(`${repo}/flight-plans`, owner, { body: { goal: 'Retry twice', branch: 'fix' } });
  expect(filed.status).toBe(400);
  expect(filed.body.error.code).toBe('NOT_SUPPORTED');
  const show = await api(`${repo}/changes/${number}`, owner);
  expect(show.status).toBe(200);
  expect(show.body.flight_plan).toBeNull();
  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'reader', scopes: ['read'] } });
  const reader = { token: minted.body.token as string };
  expect((await api(`${repo}/flight-plans`, reader, { body: { goal: 'g', branch: 'fix' } })).status).toBe(403);
});

it('brings open findings to a new session on the branch, and they clear when resolved', async () => {
  const { owner, repo, number, head } = await setup('around');
  const anchor = { commit: head, path: 'b.md', line: 1, side: 'new' };
  await api(`${repo}/changes/${number}/comments`, owner, { body: { body: '**High: wrong word**', ...anchor } });
  const context = await api(`${repo}/context?branch=fix`, owner);
  expect(context.status).toBe(200);
  expect(context.body.go_around).toMatchObject({ change: number, open: 1 });
  expect(context.body.go_around.findings[0]).toMatchObject({ path: 'b.md', line: 1, side: 'new', on_head: true });
  const show = await api(`${repo}/changes/${number}`, owner);
  expect(show.body.go_around).toEqual(context.body.go_around);
  await api(`${repo}/changes/${number}/comments`, owner, { body: { ...anchor, resolve: true } });
  expect((await api(`${repo}/context?branch=fix`, owner)).body.go_around.open).toBe(0);
  expect((await api(`${repo}/context`, owner)).body.go_around).toBeNull();
});
