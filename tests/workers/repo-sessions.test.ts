// B8 session records through the real authority (workerd): the pusher posts one with write
// and reads it back (REST and MCP), a reader cannot post, another writer is not the pusher,
// a summary holding a credential is refused without echoing it, and a path-restricted
// token sees none. The repository's records list newest first with their session ids, and
// the agent context a new coding session starts from gathers them with the landing rules
// and the open changes.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const record = { cli: 'claude-code', model: 'claude-sonnet-5-5', summary: 'Added the parser and its tests.', prompt_digest: 'a'.repeat(64), read_set_digest: 'b'.repeat(64), transcript_ref: 'claude-code:session-1' };

it('keeps the session records of a commit for its pusher', async () => {
  const cookie = await signup('sessions_owner');
  const created = await api('/repos', { cookie }, { body: { name: 'sessions', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const mint = async (name: string, scopes: string[], paths?: string[]) =>
    (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name, scopes, ...(paths ? { paths } : {}) } })).body.token as string;
  const [agent, other, reader, docs] = [await mint('agent', ['read', 'write']), await mint('other', ['read', 'write']), await mint('reader', ['read']), await mint('docs', ['read', 'write'], ['docs/'])];
  const made = await api(`/repos/${repo}/commits`, { token: agent }, { body: { ref: 'main', changes: [file('src/p.ts', 'export {}\n')], message: 'parser', author } });
  const sha = made.body.commit as string;
  const post = (token: string, body: object) => api(`/repos/${repo}/commits/${sha}/sessions`, { token }, { body });

  const posted = await post(agent, record);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  expect((await post(agent, record)).body).toMatchObject({ session: posted.body.session, already: true });
  expect((await post(reader, record)).status).toBe(403);
  expect((await post(other, record)).status).toBe(403);
  // The fake key is assembled at runtime; the refusal names the field, never the key.
  const fake = ['sk-ant-', 'api03-'].join('') + 'Ab1'.repeat(31);
  const leaked = await post(agent, { ...record, summary: `debugged with ${fake}` });
  expect(leaked.status).toBe(422);
  expect(leaked.body.error.code).toBe('SECRET_DETECTED');
  expect(JSON.stringify(leaked.body)).not.toContain(fake);
  expect((await post(agent, { ...record, summary: 'x'.repeat(4097) })).status).toBe(400);

  const listed = await api(`/repos/${repo}/commits/${sha}/sessions`, { token: reader });
  expect(listed.body.sessions).toHaveLength(1);
  expect(listed.body.sessions[0]).toMatchObject({ ...record, recorded_by: 'token:agent' });
  expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: docs })).status).toBe(403);
  // The same operation through MCP.
  const mcp = await api(`/repos/${repo}/mcp`, { token: reader }, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_sessions', arguments: { commit: sha } } } });
  expect(JSON.parse(mcp.body.result.content[0].text).sessions).toHaveLength(1);
});

it('lists sessions newest first and serves the agent context', async () => {
  const cookie = await signup('sessions_context');
  const created = await api('/repos', { cookie }, { body: { name: 'context', policy: { approvals: 1, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const agent = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'agent', scopes: ['read', 'write'] } })).body.token as string;
  const shas: string[] = [];
  for (const n of [1, 2]) {
    const made = await api(`/repos/${repo}/commits`, { token: agent }, { body: { ref: 'main', changes: [file(`src/${n}.ts`, 'export {}\n')], message: `step ${n}\n\nbody`, author } });
    shas.push(made.body.commit);
    const posted = await api(`/repos/${repo}/commits/${made.body.commit}/sessions`, { token: agent }, { body: { cli: 'opencode', model: 'zai-coding-plan/glm-5.3', summary: `did step ${n}`, session_id: 'opencode:ses_1' } });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  }
  const recent = await api(`/repos/${repo}/sessions?limit=1`, { token: agent });
  expect(recent.body.sessions).toHaveLength(1);
  expect(recent.body.sessions[0]).toMatchObject({ commit: shas[1], subject: 'step 2', summary: 'did step 2', session_id: 'opencode:ses_1' });
  const older = await api(`/repos/${repo}/sessions?limit=1&before=${recent.body.next}`, { token: agent });
  expect(older.body.sessions[0].commit).toBe(shas[0]);
  expect((await api(`/repos/${repo}/sessions?limit=0`, { token: agent })).status).toBe(400);

  const context = await api(`/repos/${repo}/context?branch=main&paths=src/1.ts,src/2.ts&sessions=5`, { token: agent });
  expect(context.status, JSON.stringify(context.body)).toBe(200);
  // Approvals hold the commits off main; the context still shows what their sessions did.
  expect(context.body).toMatchObject({ branch: { name: 'main', head: context.body.main }, policy: { approvals: 1 }, changes: [] });
  expect(context.body.sessions.map((s: { summary: string }) => s.summary)).toEqual(['did step 2', 'did step 1']);
  const mcp = await api(`/repos/${repo}/mcp`, { token: agent }, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_context', arguments: { paths: ['src/1.ts'], sessions: 1 } } } });
  expect(JSON.parse(mcp.body.result.content[0].text).sessions).toHaveLength(1);
});
