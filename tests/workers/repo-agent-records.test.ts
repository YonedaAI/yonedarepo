// The web's agent pages read through the real authority (workerd): sessions repo-wide,
// newest first and filtered, one session with its commit and reads, pins and bisects (none
// yet) and contract records; a path-restricted token reads no sessions and bad cursors are
// refused before the authority.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('lists agent records for the agent pages', async () => {
  const cookie = await signup('agent_pages_owner');
  const created = await api('/repos', { cookie }, { body: { name: 'agent-pages', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const mint = async (name: string, scopes: string[], paths?: string[]) =>
    (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name, scopes, ...(paths ? { paths } : {}) } })).body.token as string;
  const [agent, reader, docs] = [await mint('agent', ['read', 'write']), await mint('reader', ['read']), await mint('docs', ['read'], ['docs/'])];
  const made = await api(`/repos/${repo}/commits`, { token: agent }, { body: { ref: 'main', changes: [file('src/p.ts', 'export {}\n')], message: 'parser\n\nbody', author } });
  const sha = made.body.commit as string;
  for (const cli of ['claude-code', 'opencode'])
    expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { cli, model: `${cli}-m`, summary: `${cli} work`, transcript_ref: 'shared:1' } })).status).toBe(200);

  const listed = await api(`/repos/${repo}/sessions`, { token: reader });
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listed.body.sessions.map((s: { cli: string }) => s.cli)).toEqual(['opencode', 'claude-code']);
  expect(listed.body.next).toBe(null);
  expect(listed.body.sessions[0]).toMatchObject({ commit: sha, subject: 'parser', recorded_by: 'token:agent' });
  expect(listed.body.clis).toEqual(['claude-code', 'opencode']);
  // The agent's commit is staged, not yet on main; the owner's session on main's root is.
  const root = (await api(`/repos/${repo}/refs`, { token: reader })).body.refs['refs/heads/main'];
  expect((await api(`/repos/${repo}/commits/${root}/sessions`, { cookie }, { body: { cli: 'claude-code', summary: 'seeded' } })).status).toBe(200);
  const filtered = await api(`/repos/${repo}/sessions?cli=claude-code&ref=main&limit=5`, { token: reader });
  expect(filtered.body.sessions.map((s: { commit: string }) => s.commit)).toEqual([root]);
  expect(filtered.body.ref).toBe('refs/heads/main');
  const page = await api(`/repos/${repo}/sessions?limit=1&cli=opencode`, { token: reader });
  expect(page.body.next).toBe(null);
  const two = await api(`/repos/${repo}/sessions?limit=2`, { token: reader });
  expect((await api(`/repos/${repo}/sessions?before=${two.body.next}`, { token: reader })).body.sessions).toHaveLength(1);
  expect((await api(`/repos/${repo}/sessions?limit=x`, { token: reader })).status).toBe(400);

  const shown = await api(`/repos/${repo}/sessions/${page.body.sessions[0].id}`, { token: reader });
  expect(shown.body.commit).toMatchObject({ id: sha, message: 'parser\n\nbody' });
  expect(shown.body.related).toHaveLength(1);
  expect((await api(`/repos/${repo}/sessions/999`, { token: reader })).status).toBe(404);
  expect((await api(`/repos/${repo}/sessions`, { token: docs })).status).toBe(403);

  expect((await api(`/repos/${repo}/pins`, { token: reader })).body).toEqual({ pins: [] });
  expect((await api(`/repos/${repo}/bisect`, { token: reader })).body).toEqual({ bisects: [] });
  expect((await api(`/repos/${repo}/contracts`, { token: reader })).body).toEqual({ records: [], next: null });
});
