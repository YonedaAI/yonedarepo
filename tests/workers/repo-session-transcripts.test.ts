// Session transcripts through the real authority and R2 (workerd): a record posted with a
// transcript keeps it redacted (a fake key never reaches storage or a reader), fitted to
// the 1 MiB cap, readable by the repository's readers through REST and named by the record;
// MCP posts one the same way; a private repository's transcript is NOT_FOUND to anyone else.
import { expect, it } from 'vitest';
import { transcriptKey } from '../../cloudflare/worker/repo-session-records';
import { api, author, bindings, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

// Assembled at runtime: this source holds no credential shape.
const fake = ['sk-ant-', 'api03-'].join('') + 'Ab1'.repeat(31);
const transcript = {
  context: 'YonedaRepo: main at abc1234. Landing needs 0 approvals.',
  turns: [
    { kind: 'prompt', text: `Add the parser. The key is ${fake}` },
    { kind: 'tool', name: 'Read', subject: 'src/p.ts', input: 'file_path: src/p.ts', output: 'export {}' },
    { kind: 'tool', name: 'Bash', subject: 'npm test', input: `command: KEY=${fake} npm test`, output: 'FAIL', error: true },
    { kind: 'reply', text: 'Added the parser; tests pass.' },
  ],
};

async function setUp(name: string) {
  const cookie = await signup(`${name}_owner`);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const agent = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'agent', scopes: ['read', 'write'] } })).body.token as string;
  const made = await api(`/repos/${repo}/commits`, { token: agent }, { body: { ref: 'main', changes: [file('src/p.ts', 'export {}\n')], message: 'parser', author } });
  return { cookie, repo, agent, sha: made.body.commit as string };
}

it('stores a redacted transcript with the record and serves it to readers', async () => {
  const { cookie, repo, agent, sha } = await setUp('transcripts');
  const record = { cli: 'claude-code', model: 'claude-sonnet-5-5', summary: 'Added the parser.', session_id: 'claude-code:s1' };
  const posted = await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { ...record, transcript } });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  const id = posted.body.session;

  const shown = await api(`/repos/${repo}/sessions/${id}`, { cookie });
  const meta = shown.body.session.transcript;
  expect(meta).toMatchObject({ turns: 4, redactions: 2, truncated: false, context: true });
  expect(shown.body.session.transcript_ref).toBe(`transcript:sha256:${meta.sha256}`);
  const stored = await bindings.OBJECTS.get(transcriptKey(repo, meta.sha256));
  const text = await stored!.text();
  expect(text.length).toBe(meta.bytes);
  expect(text).not.toContain(fake);

  const read = await api(`/repos/${repo}/sessions/${id}/transcript`, { cookie });
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(JSON.stringify(read.body)).not.toContain(fake);
  expect(read.body.document.context).toBe(transcript.context);
  expect(read.body.document.turns[0].text).toBe('Add the parser. The key is [REDACTED:anthropic-key]');
  expect(read.body.document.turns[2]).toMatchObject({ kind: 'tool', name: 'Bash', input: 'command: KEY=[REDACTED:anthropic-key] npm test', error: true });
  expect(read.body.document.redactions).toEqual({ 'anthropic-key': 2 });
  // The same record again answers the first; a record without one has none to read.
  expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { ...record, transcript } })).body).toMatchObject({ session: id, already: true });
  const plain = await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { cli: 'opencode', summary: 'No transcript.' } });
  expect((await api(`/repos/${repo}/sessions/${plain.body.session}/transcript`, { cookie })).status).toBe(404);
  // The summary still refuses a credential outright, and a malformed transcript is refused.
  expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { ...record, summary: fake, transcript } })).status).toBe(422);
  expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { ...record, transcript: { turns: [{ kind: 'thought' }] } } })).status).toBe(400);

  // MCP posts one the same way.
  const mcp = await api(`/repos/${repo}/mcp`, { token: agent }, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_session_record', arguments: { commit: sha, cli: 'codex', summary: 'Through MCP.', transcript: { turns: [{ kind: 'prompt', text: 'Hi' }] } } } } });
  const viaMcp = JSON.parse(mcp.body.result.content[0].text);
  expect((await api(`/repos/${repo}/sessions/${viaMcp.session}/transcript`, { token: agent })).body.document.turns).toEqual([{ kind: 'prompt', text: 'Hi' }]);
});

it('caps a stored transcript at 1 MiB', async () => {
  const { cookie, repo, agent, sha } = await setUp('transcript_cap');
  const turns = [{ kind: 'prompt', text: 'Start' }, ...Array.from({ length: 150 }, (_, n) => ({ kind: 'tool', name: 'Read', subject: `src/${n}.ts`, output: 'x'.repeat(20_000) })), { kind: 'reply', text: 'Finished.' }];
  const posted = await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { cli: 'claude-code', summary: 'Big.', transcript: { turns } } });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  const read = await api(`/repos/${repo}/sessions/${posted.body.session}/transcript`, { cookie });
  expect(read.body.transcript.bytes).toBeLessThanOrEqual(1024 * 1024);
  expect(read.body.transcript.truncated).toBe(true);
  const kept = read.body.document.turns;
  expect(kept[0].text).toBe('Start');
  expect(kept[1]).toMatchObject({ kind: 'omitted' });
  expect(kept.at(-1).text).toBe('Finished.');
  expect(kept[1].turns + kept.length - 2).toBe(151);
  // A body past the request limit is refused before anything is computed.
  const huge = { cli: 'claude-code', summary: 'Too big.', transcript: { turns: [{ kind: 'prompt', text: 'x'.repeat(5 * 1024 * 1024) }] } };
  expect((await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: huge })).status).toBe(400);
});

it("keeps a private repository's transcripts from anyone who is not a member", async () => {
  const { cookie, repo, agent, sha } = await setUp('transcript_private');
  const posted = await api(`/repos/${repo}/commits/${sha}/sessions`, { token: agent }, { body: { cli: 'claude-code', summary: 'Private.', transcript } });
  const path = `/repos/${repo}/sessions/${posted.body.session}/transcript`;
  expect((await api(path, { cookie })).status).toBe(200);
  const stranger = { cookie: await signup('transcript_stranger') };
  for (const who of [{}, stranger]) expect((await api(path, who)).status).toBe(404);
  // Public, its readers include everyone.
  expect((await api(`/repos/${repo}/visibility`, { cookie }, { method: 'PUT', body: { visibility: 'public' } })).status).toBe(200);
  expect((await api(path, stranger)).status).toBe(200);
});
