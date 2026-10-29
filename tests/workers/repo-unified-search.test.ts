// One search across a repository through the Worker: the code at a revision, memories, and
// the commits, session records and change requests whose text holds the query's words,
// each its own group with a count (REST and MCP `git_grep`). `groups` narrows it; a
// path-restricted token finds only commits touching its grant and no sessions or changes.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function mcp(repo: string, token: string, args: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_grep', arguments: args } }),
    }),
    scoped,
  );
  return (await response.json<any>()).result;
}

it('answers code, commits, sessions and changes in one query', async () => {
  const cookie = await signup('unified_search');
  const owner = { cookie };
  const files = [file('src/retry.rs', 'pub fn retry() { backoff() }\n'), file('docs/guide.md', '# Guide\n')];
  const created = await api('/repos', owner, { body: { name: 'unified', policy: { required_checks: [], approvals: 0 }, files, author } });
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const mint = async (name: string, scopes: string[], paths?: string[]) =>
    (await api(`${repo}/tokens`, owner, { body: { name, scopes, ...(paths ? { paths } : {}) } })).body.token as string;
  const [reader, docs] = [await mint('reader', ['read']), await mint('docs', ['read'], ['docs/'])];

  const made = await api(`${repo}/commits`, owner, {
    body: { ref: 'main', changes: [file('src/fetch.rs', 'x\n')], message: 'Retry fetches with backoff', author },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const commit = made.body.commit as string;
  const recorded = await api(`${repo}/commits/${commit}/sessions`, owner, {
    body: { cli: 'opencode', summary: 'Added retry backoff to the fetcher', session_id: 'opencode:ses_1' },
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  await api(`${repo}/refs/batch`, owner, { body: { updates: [{ ref: 'retry', commit, expected: null }] } });
  const opened = await api(`${repo}/changes`, owner, { body: { branch: 'retry', title: 'Retry with backoff', body: 'Fixes flaky fetches.' } });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  const found = await api(`${repo}/search?query=${encodeURIComponent('retry backoff')}`, { token: reader });
  expect(found.status, JSON.stringify(found.body)).toBe(200);
  expect(found.body.groups).toEqual(['code', 'memories', 'commits', 'sessions', 'changes']);
  expect(found.body.commits.count).toBe(1);
  expect(found.body.commits.results[0]).toMatchObject({ commit, subject: 'Retry fetches with backoff', paths: ['src/fetch.rs'] });
  expect(found.body.sessions.results[0]).toMatchObject({ commit, session_id: 'opencode:ses_1' });
  expect(found.body.changes.results[0]).toMatchObject({ number: opened.body.number, title: 'Retry with backoff' });
  expect(found.body.memories).toEqual([]);
  // The code group: one line holds both words.
  expect((await api(`${repo}/search?query=backoff`, { token: reader })).body.results.map((r: any) => r.path)).toEqual(['src/retry.rs']);

  // Only the groups asked for: no code is read.
  const records = await api(`${repo}/search?query=retry&groups=commits,changes`, { token: reader });
  expect(records.body.commit).toBeNull();
  expect(records.body.results).toEqual([]);
  expect(records.body.sessions).toBeNull();
  expect(records.body.changes.count).toBe(1);
  expect((await api(`${repo}/search?query=retry&groups=wiki`, { token: reader })).status).toBe(400);

  // A path-restricted token: no commit here touches its grant, and no sessions or changes.
  const restricted = await api(`${repo}/search?query=retry`, { token: docs });
  expect(restricted.status).toBe(200);
  expect(restricted.body.commits).toMatchObject({ count: 0, results: [] });
  expect(restricted.body.sessions).toBeNull();
  expect(restricted.body.changes).toBeNull();

  // MCP carries the same groups.
  const viaMcp = JSON.parse((await mcp(id, reader, { query: 'retry', groups: ['sessions'] })).content[0].text);
  expect(viaMcp.sessions.count).toBe(1);
  expect(viaMcp.commits).toBeNull();
});
