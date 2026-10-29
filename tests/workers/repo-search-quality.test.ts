// Code search answers in rank order: files where the query is a whole word (an identifier
// boundary on both sides) first, then files whose path holds it, then files where it is
// only part of a word, each tier by hit count and then path. `word=true` keeps whole words
// only. Lines carry their match ranges; binary files are never reported as not searched.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const bytes = (path: string, data: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return { path, content_b64: btoa(binary) };
};

async function mcp(repo: string, token: string, args: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git_grep', arguments: args } }),
    }),
    scoped,
  );
  return (await response.json<any>()).result.structuredContent;
}

it('ranks whole words, then paths, then substrings, with match ranges, and leaves binaries out', async () => {
  const owner = { cookie: await signup('search_quality') };
  const gif = new Uint8Array(4.5 * 1024 * 1024).map((_, i) => (i * 7) & 255);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const files = [
    file('Dockerfile', 'ARG CLAUDE_CODE_VERSION=latest\n'),
    file('src/runner.ts', 'export function test() {}\ntest();\ntest();\n'),
    file('src/one.ts', 'test(1);\n'),
    file('test/helpers.md', 'nothing here\n'),
    bytes('logo.png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x74, 0x65, 0x73, 0x74)),
    bytes('demo.gif', gif),
    file('big.log', `${'a test log line\n'.repeat(300_000)}`),
  ];
  const created = await api('/repos', owner, { body: { name: 'search-quality', policy: { required_checks: [], approvals: 0 }, files, author } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const repo = created.body.id as string;

  const found = (await api(`/repos/${repo}/search?query=test&ignore_case=true`, owner)).body;
  expect(found.results.map((r: any) => [r.path, r.match, r.hits])).toEqual([
    ['src/runner.ts', 'word', 3],
    ['src/one.ts', 'word', 1],
    ['test/helpers.md', 'path', 0],
    ['Dockerfile', 'substring', 1],
  ]);
  // Each line's matches, as offsets into its text (what the page marks).
  const runner = found.results[0];
  expect(runner.lines[0]).toEqual({ line: 1, text: 'export function test() {}', ranges: [[16, 20]] });
  expect(found.results[3].lines[0].ranges).toEqual([[26, 30]]);
  // Only the text file over the cap is named; the GIF and PNG are binary.
  expect(found.skipped_files).toEqual([{ path: 'big.log', reason: 'larger than 4 MiB' }]);
  expect(found.skipped_count).toBe(1);

  // Whole words only: `latest` is no longer a hit; a path holding the word still is.
  const words = (await api(`/repos/${repo}/search?query=test&ignore_case=true&word=true`, owner)).body;
  expect(words.results.map((r: any) => r.path)).toEqual(['src/runner.ts', 'src/one.ts', 'test/helpers.md']);
  // The same over MCP.
  const { token } = (await api(`/repos/${repo}/tokens`, owner, { body: { name: 'mcp', scopes: ['read'] } })).body;
  const viaMcp = await mcp(repo, token, { query: 'test', ignore_case: true, word: true });
  expect(viaMcp.results.map((r: any) => r.path)).toEqual(['src/runner.ts', 'src/one.ts', 'test/helpers.md']);
});
