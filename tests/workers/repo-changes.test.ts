// Change requests through the real authority (workerd): a stock push of a branch suggests
// opening a change; the change follows the branch's pushes; anchored comments; approval is
// a review of the head commit; landing the head on main lands the change in the same
// transaction; close and reopen; the same operations over MCP; change hooks get events. A
// change on another base branch diffs against it and lands on it with only `write`.
import { expect, it } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

type Raw = { id: string; kind: 'commit' | 'tree' | 'blob'; data: Uint8Array };
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function object(kind: Raw['kind'], data: Uint8Array): Promise<Raw> {
  const header = text.encode(`${kind} ${data.length}\0`);
  const whole = new Uint8Array(header.length + data.length);
  whole.set(header);
  whole.set(data, header.length);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', whole))), kind, data };
}

/** A commit on `parent` whose tree is `a.md` and `retry.ts` with `body`. */
async function commitOf(parent: string, body: string) {
  const blobs = [await object('blob', text.encode('a\n')), await object('blob', text.encode(body))];
  const parts = [`100644 a.md\0`, `100644 retry.ts\0`].flatMap((name, i) => [
    ...text.encode(name),
    ...Uint8Array.from(blobs[i].id.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
  ]);
  const tree = await object('tree', new Uint8Array(parts));
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  const commit = await object('commit', text.encode(`tree ${tree.id}\nparent ${parent}\nauthor ${who}\ncommitter ${who}\n\nretry\n`));
  return [commit, tree, ...blobs];
}

/** Pushes `objects` to `refname` like stock Git with side-band-64k, returning the report. */
async function push(repo: string, token: string, refname: string, old: string | null, objects: Raw[]) {
  const { push_b64 } = compute({
    op: 'branch_push',
    refname,
    old,
    new: objects[0].id,
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data_b64: btoa(String.fromCharCode(...o.data)) })),
  });
  const body = Uint8Array.from(atob(push_b64), (c) => c.charCodeAt(0));
  // Ask for side-band-64k, where remote messages travel: rewrite the first pkt-line.
  const length = Number.parseInt(new TextDecoder().decode(body.slice(0, 4)), 16);
  const line = new TextDecoder().decode(body.slice(4, length)).replace('report-status', 'report-status side-band-64k');
  const first = text.encode(line);
  const request = new Uint8Array([...text.encode((first.length + 4).toString(16).padStart(4, '0')), ...first, ...body.slice(length)]);
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`git:${token}`)}` },
      body: request,
    }),
    scoped,
  );
  return new TextDecoder().decode(await response.arrayBuffer());
}

it('opens, discusses, approves and lands a change with its branch head', async () => {
  const cookie = await signup('changes_owner');
  const created = await api('/repos', { cookie }, { body: { name: 'changes', policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const mint = async (name: string, scopes: string[], paths?: string[]) =>
    (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name, scopes, ...(paths ? { paths } : {}) } })).body.token as string;
  const [agent, reader, docs] = [await mint('agent', ['read', 'write']), await mint('reader', ['read']), await mint('docs', ['read', 'write'], ['docs/'])];
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'] as string;

  // A pushed branch with no open change suggests opening one.
  const first = await commitOf(main, 'export const tries = 2;\n');
  const report = await push(repo, agent, 'refs/heads/fix', null, first);
  expect(report).toContain('ok refs/heads/fix');
  expect(report).toContain('open a change: yoneda change create fix');

  const opened = await api(`/repos/${repo}/changes`, { token: agent }, { body: { branch: 'fix', title: 'Retry twice', body: 'Flaky fetches.' } });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  expect(opened.body).toMatchObject({ number: 1, branch: 'fix', base: 'main', status: 'open', head: first[0].id, author: 'token:agent', comment_count: 0 });
  expect((await api(`/repos/${repo}/changes`, { token: agent }, { body: { branch: 'fix', title: 'Again' } })).status).toBe(409);
  expect((await api(`/repos/${repo}/changes`, { token: reader }, { body: { branch: 'fix', title: 'x' } })).status).toBe(403);
  expect((await api(`/repos/${repo}/changes`, { token: docs })).status).toBe(403);

  // A second push moves the head and names the change.
  const second = await commitOf(first[0].id, 'export const tries = 3;\n');
  const again = await push(repo, agent, 'refs/heads/fix', first[0].id, second);
  expect(again).toContain('change #1 now at this push');
  const head = second[0].id;
  const shown = await api(`/repos/${repo}/changes/1?patch=1`, { token: reader });
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  expect(shown.body.head).toBe(head);
  expect(shown.body.head_commit.gates).toMatchObject({ ready: false, approvals: 0, approvals_required: 1 });
  expect(shown.body.timeline.map((m: any) => m.action)).toEqual(['moved', 'created']);
  expect(shown.body.diff.base.commit).toBe(main);
  expect(shown.body.diff.changes.map((c: any) => c.path)).toEqual(['retry.ts']);
  expect(shown.body.diff.changes[0].patch).toContain('+export const tries = 3;');

  // An inline comment on the new line, then resolved with a reply.
  const comments = `/repos/${repo}/changes/1/comments`;
  const anchor = { path: 'retry.ts', line: 1, side: 'new' };
  const said = await api(comments, { cookie }, { body: { body: 'Why three?', ...anchor } });
  expect(said.status, JSON.stringify(said.body)).toBe(200);
  expect(said.body.comment).toMatchObject({ commit: head, ...anchor, principal: expect.any(String), resolved_at: null });
  const done = await api(comments, { token: agent }, { body: { body: 'Measured.', resolve: true, ...anchor } });
  expect(done.body.resolved).toBe(2);
  expect((await api(comments, { token: reader }, { body: { body: 'x' } })).status).toBe(403);

  // Approve the head (git_review), then land it on main: the change lands with it.
  expect((await api(`/repos/${repo}/commits/${head}/reviews`, { cookie }, { body: { decision: 'approve' } })).status).toBe(200);
  const landed = await api(`/repos/${repo}/land`, { cookie }, { body: { ref: 'main', commit: head } });
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  const after = await api(`/repos/${repo}/changes/1`, { token: reader });
  expect(after.body).toMatchObject({ status: 'landed', landed_version: landed.body.version, landed_commit: head, head, comment_count: 2 });
  // A landed change still shows what it changed: against main just before it landed.
  expect(after.body.diff.changes.map((c: any) => c.path)).toEqual(['retry.ts']);
  expect((await api(`/repos/${repo}/changes?status=landed`, { token: reader })).body.changes.map((c: any) => c.number)).toEqual([1]);
  expect((await api(`/repos/${repo}/changes`, { token: reader })).body.changes).toEqual([]);

  // Close and reopen over MCP, with the same rules.
  const mcp = (name: string, args: object, token = agent) =>
    api(`/repos/${repo}/mcp`, { token }, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const reopened = await mcp('git_change_create', { branch: 'fix', title: 'Follow-up' });
  expect(reopened.body.result.structuredContent).toMatchObject({ number: 2, status: 'open' });
  expect((await mcp('git_change_close', { number: 2 })).body.result.structuredContent.status).toBe('closed');
  expect((await mcp('git_change_reopen', { number: 2 })).body.result.structuredContent.status).toBe('open');
  expect((await mcp('git_change_close', { number: 2 }, reader)).body.result.isError).toBe(true);
  const listed = await mcp('git_change_list', { status: 'all' }, reader);
  expect(listed.body.result.structuredContent.changes.map((c: any) => c.number)).toEqual([2, 1]);
  expect((await api(`/repos/${repo}/changes/9`, { token: reader })).status).toBe(404);

  // Delete: a closed change only (a landed one stays), by its author or the owner.
  const remove = (n: number, auth: { cookie?: string; token?: string }) =>
    api(`/repos/${repo}/changes/${n}`, auth, { method: 'DELETE' });
  expect((await remove(1, { cookie })).body.error.code).toBe('CONFLICT');
  expect((await remove(2, { token: agent })).body.error.code).toBe('CONFLICT');
  expect((await mcp('git_change_close', { number: 2 })).body.result.structuredContent.status).toBe('closed');
  expect((await remove(2, { token: reader })).status).toBe(403);
  const gone = await remove(2, { token: agent });
  expect([gone.status, gone.body]).toEqual([200, { number: 2, deleted: true }]);
  expect((await api(`/repos/${repo}/changes/2`, { token: reader })).status).toBe(404);
  const third = await mcp('git_change_create', { branch: 'fix', title: 'Third' });
  expect(third.body.result.structuredContent.number).toBe(3);
  await mcp('git_change_close', { number: 3 });
  expect((await mcp('git_change_delete', { number: 3 })).body.result.structuredContent).toEqual({ number: 3, deleted: true });
  const left = await mcp('git_change_list', { status: 'all' }, reader);
  expect(left.body.result.structuredContent.changes.map((c: any) => c.number)).toEqual([1]);
});

it('lands a change on its own base branch, leaving main alone', async () => {
  const cookie = await signup('changes_base');
  const created = await api('/repos', { cookie }, { body: { name: 'bases', policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const agent = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'agent', scopes: ['read', 'write'] } })).body.token as string;
  const main = (await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main'] as string;
  const stage = await commitOf(main, 'export const tries = 2;\n');
  expect(await push(repo, agent, 'refs/heads/stage', null, stage)).toContain('ok refs/heads/stage');
  const fix = await commitOf(stage[0].id, 'export const tries = 3;\n');
  expect(await push(repo, agent, 'refs/heads/fix', null, fix)).toContain('ok refs/heads/fix');

  const open = (body: object) => api(`/repos/${repo}/changes`, { token: agent }, { body: { branch: 'fix', title: 'Stage it', ...body } });
  expect((await open({ base: 'nope' })).body.error.code).toBe('NOT_FOUND');
  expect((await open({ base: 'fix' })).body.error.code).toBe('INVALID_INPUT');
  const mcp = await api(`/repos/${repo}/mcp`, { token: agent }, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_change_create', arguments: { branch: 'fix', base: 'stage', title: 'Stage it' } } } });
  expect(mcp.body.result.structuredContent).toMatchObject({ number: 1, base: 'stage', head: fix[0].id });
  const shown = await api(`/repos/${repo}/changes/1?patch=1`, { token: agent });
  expect(shown.body).toMatchObject({ base: 'stage', base_protected: false });
  expect(shown.body.diff.base.commit).toBe(stage[0].id);
  expect(shown.body.diff.changes[0].patch).toContain('+export const tries = 3;');

  // Unapproved and unchecked: an unprotected base takes the head with the write scope.
  const landed = await api(`/repos/${repo}/land`, { token: agent }, { body: { ref: 'stage', commit: fix[0].id } });
  expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  expect((await api(`/repos/${repo}/changes/1`, { token: agent })).body).toMatchObject({ status: 'landed', landed_commit: fix[0].id });
  expect((await api(`/repos/${repo}/refs`, { cookie })).body.refs['refs/heads/main']).toBe(main);
});
