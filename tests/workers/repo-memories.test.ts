// Repository memories through the Worker: anchors are resolved at the memory's commit (blob
// and node digest by the adapter, never taken from the caller), readers list and rank them
// while only writers add, a private repository hides them, a path-restricted token reads
// none (and its search answers without the memories group), the anchored code changing on
// main makes a memory stale, ranking leaves out what a session was already shown, and MCP
// carries the same operations.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const RETRY = `/// Retries an operation with backoff.
pub fn retry(times: u32) -> u32 {
    backoff(times)
}

/// Delay before the next attempt.
pub fn backoff(n: u32) -> u32 {
    n * 2
}
`;

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const files = [file('src/retry.rs', RETRY), file('docs/guide.md', '# Guide\n')];
  const created = await api('/repos', owner, {
    body: { name, policy: { required_checks: [], approvals: 0 }, files, author },
  });
  const repo = `/repos/${created.body.id}`;
  const mint = async (label: string, scopes: string[], paths?: string[]) => ({
    token: (await api(`${repo}/tokens`, owner, { body: { name: label, scopes, paths } })).body
      .token as string,
  });
  return {
    owner,
    id: created.body.id as string,
    repo,
    bot: await mint('bot', ['read', 'write', 'land']),
    reader: await mint('reader', ['read']),
    docs: await mint('docs', ['read', 'write'], ['docs/']),
  };
}

async function mcp(repo: string, token: string, name: string, args: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    scoped,
  );
  return (await response.json<any>()).result;
}

it('resolves anchors, ranks memories for a file and marks them stale once the code changes', async () => {
  const { repo, bot, reader, docs } = await setup('memories');
  const added = await api(`${repo}/memories`, bot, {
    body: {
      kind: 'gotcha',
      text: 'backoff() doubles the delay; the land queue depends on it.',
      anchors: [{ path: 'src/retry.rs', symbol_path: 'backoff' }],
      session_id: 'claude-code:s1',
    },
  });
  expect(added.status).toBe(200);
  const id = added.body.memory as number;
  // A caller's blob is replaced by the file's real one.
  const onFile = await api(`${repo}/memories`, bot, {
    body: { kind: 'constraint', text: 'retry.rs stays dependency free.', anchors: [{ path: 'src/retry.rs', blob: '0'.repeat(40) }] },
  });
  const shown = await api(`${repo}/memories/${id}`, reader);
  expect(shown.status).toBe(200);
  expect(shown.body.memory).toMatchObject({ kind: 'gotcha', status: 'active', stale: false, session_id: 'claude-code:s1' });
  const anchor = shown.body.memory.anchors[0];
  expect(anchor.blob).toMatch(/^[0-9a-f]{40}$/);
  expect(anchor.node_digest).toMatch(/^[0-9a-f]{64}$/);
  const fileAnchor = (await api(`${repo}/memories/${onFile.body.memory}`, reader)).body.memory.anchors[0];
  expect(fileAnchor.blob).toBe(anchor.blob);
  // An unknown symbol, a reader's write, a credential and a stranger are all refused.
  expect(
    (await api(`${repo}/memories`, bot, { body: { kind: 'howto', text: 'x', anchors: [{ path: 'src/retry.rs', symbol_path: 'nope' }] } })).status,
  ).toBe(404);
  expect((await api(`${repo}/memories`, reader, { body: { kind: 'howto', text: 'x' } })).status).toBe(403);
  const fake = ['sk-ant-', 'api03-'].join('') + 'Ab1'.repeat(31);
  const leaked = await api(`${repo}/memories`, bot, { body: { kind: 'howto', text: `use ${fake}` } });
  expect(leaked.body.error.code).toBe('SECRET_DETECTED');
  const stranger = { cookie: await signup('stranger') };
  expect((await api(`${repo}/memories`, stranger)).status).toBe(404);
  // A path-restricted token reads no memories; its code search still answers.
  expect((await api(`${repo}/memories`, docs)).status).toBe(403);
  const docsSearch = await api(`${repo}/search?query=Guide`, docs);
  expect(docsSearch.status).toBe(200);
  expect(docsSearch.body.memories).toBeNull();
  // Search finds code and memories in one query.
  const search = await api(`${repo}/search?query=backoff`, reader);
  expect(search.body.results.map((r: any) => r.path)).toContain('src/retry.rs');
  expect(search.body.memories.map((m: any) => m.id)).toEqual([id]);

  // Ranked for the file: the symbol's memory and the file's; delivery dedupes per session.
  const relevant = await api(`${repo}/context/relevant?paths=src/retry.rs&types=memory&session_id=claude-code:s1`, bot);
  expect(relevant.body.items.map((i: any) => i.id).sort()).toEqual([id, onFile.body.memory].sort());
  const delivered = await api(`${repo}/context/deliveries`, bot, {
    body: { session_id: 'claude-code:s1', trigger: 'read', subject: 'src/retry.rs', items: [{ type: 'memory', id }], bytes: 90 },
  });
  expect(delivered.status).toBe(200);
  const again = await api(`${repo}/context/relevant?paths=src/retry.rs&types=memory&session_id=claude-code:s1`, bot);
  expect(again.body.items.map((i: any) => i.id)).toEqual([onFile.body.memory]);
  expect(again.body.delivered).toEqual({ bytes: 90, count: 1 });
  const listed = await api(`${repo}/context/deliveries?session_id=claude-code:s1`, reader);
  expect(listed.body.deliveries[0].items[0].label).toContain('backoff() doubles the delay');
  // The session start's context carries them too.
  expect((await api(`${repo}/context?paths=src/retry.rs`, bot)).body.memories.length).toBe(2);

  // backoff changes on main: both memories are stale at head, fresh as of before.
  const pinned = (await api(`${repo}`, bot)).body.version as number;
  const changed = await api(`${repo}/commits`, bot, {
    body: { ref: 'main', changes: [file('src/retry.rs', RETRY.replace('n * 2', 'n * 3'))], message: 'triple', author },
  });
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: changed.body.commit } })).body.landed).toBe(true);
  expect((await api(`${repo}/memories/${id}`, reader)).body.memory.stale).toBe(true);
  expect((await api(`${repo}/memories/${id}?at=${pinned}`, reader)).body.memory.stale).toBe(false);
  const stale = await api(`${repo}/memories?status=stale`, reader);
  expect(stale.body.memories.map((m: any) => m.id).sort()).toEqual([id, onFile.body.memory].sort());
  // Retiring keeps it, marked, and takes it out of the ranking.
  expect((await api(`${repo}/memories/${id}/retire`, bot, { body: { reason: 'backoff is linear now' } })).status).toBe(200);
  const retired = (await api(`${repo}/memories/${id}`, reader)).body.memory;
  expect(retired).toMatchObject({ status: 'retired', retired: { reason: 'backoff is linear now' } });
  const after = await api(`${repo}/context/relevant?paths=src/retry.rs&types=memory`, bot);
  expect(after.body.items.map((i: any) => i.id)).toEqual([onFile.body.memory]);
});

it('carries the memory operations over MCP', async () => {
  const { id, bot, reader } = await setup('memorymcp');
  const added = await mcp(id, bot.token, 'git_memory_add', {
    kind: 'decision',
    text: 'Retries use exponential backoff, not a queue.',
    anchors: [{ path: 'src/retry.rs', symbol_path: 'retry' }],
  });
  expect(added.isError).toBeFalsy();
  const memory = JSON.parse(added.content[0].text).memory as number;
  const ranked = await mcp(id, reader.token, 'git_context_relevant', { query: 'why exponential backoff?' });
  const items = JSON.parse(ranked.content[0].text).items;
  expect(items[0]).toMatchObject({ type: 'memory', id: memory });
  const listed = JSON.parse((await mcp(id, reader.token, 'git_memory_list', { path: 'src/' })).content[0].text);
  expect(listed.memories.map((m: any) => m.id)).toEqual([memory]);
  const refused = await mcp(id, reader.token, 'git_memory_retire', { id: memory });
  expect(refused.isError).toBe(true);
  expect(JSON.parse((await mcp(id, bot.token, 'git_memory_retire', { id: memory })).content[0].text).already).toBe(false);
});
