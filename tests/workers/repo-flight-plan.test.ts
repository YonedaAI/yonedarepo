// A flight plan through the real authority (workerd): filed over REST and MCP, shown on the
// change for its branch, secret-scanned and refused to readers; a go-around reaches a new
// session through `git_context` and `change show`, with file and line.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

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
  return { owner, id: created.body.id as string, repo, number: change.body.number as number, head: commit.body.commit as string };
}

it('files a plan over REST and MCP, and the change shows the newest one', async () => {
  const { owner, id, repo, number } = await setup('plans');
  expect((await api(`${repo}/changes/${number}`, owner)).body.flight_plan).toBeNull();
  const filed = await api(`${repo}/flight-plans`, owner, { body: { goal: 'Retry twice', scope: 'src/net', branch: 'fix' } });
  expect(filed.status).toBe(200);
  expect(filed.body.plan).toMatchObject({ goal: 'Retry twice', scope: 'src/net', branch: 'fix' });
  expect((await api(`${repo}/changes/${number}`, owner)).body.flight_plan.goal).toBe('Retry twice');

  const minted = await api(`${repo}/tokens`, owner, { body: { name: 'agent', scopes: ['read', 'write'] } });
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${id}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.body.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'git_flight_plan', arguments: { goal: 'Retry once', branch: 'fix', session_id: 'claude-code:s1' } },
      }),
    }),
    scoped,
  );
  const reply = await response.json<any>();
  expect(reply.result.isError).toBeUndefined();
  expect(reply.result.structuredContent.plan).toMatchObject({ goal: 'Retry once', session_id: 'claude-code:s1' });
  expect((await api(`${repo}/changes/${number}`, owner)).body.flight_plan.goal).toBe('Retry once');
});

it('refuses credentials, readers and path-restricted writers', async () => {
  const { owner, repo } = await setup('refused');
  const secret = ['sk-ant-', 'api03-'].join('') + 'Ab1'.repeat(31);
  const leaked = await api(`${repo}/flight-plans`, owner, { body: { goal: `use ${secret}`, branch: 'fix' } });
  expect(leaked.status).toBe(422);
  expect(leaked.body.error.code).toBe('SECRET_DETECTED');
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
