// The account-level MCP (`POST /api/v1/mcp`) in workerd: repository management plus every
// platform tool with a `repo` argument, dispatched through the shared operation table with
// the caller's own credentials (see repo-fixture.ts).
import { beforeEach, expect, it } from 'vitest';
import tools from '../../backend/crates/yoneda-core/src/platform_tools.json';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

// The platform-auth layer (PATs, repo delete) may not be merged yet: those cases run once it is.
const auth = import.meta.glob('../../cloudflare/worker/repo-admin.ts');
const hasPlatformAuth = Object.keys(auth).length > 0;
// Personal tokens are looked up in D1, like after the deployed migrations.
const tokenTables = import.meta.glob<string>('../../cloudflare/migrations/0004_platform_tokens.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});
beforeEach(async () => {
  for (const migration of Object.values(tokenTables))
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await bindings.INDEX.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim());
});

async function mcp(
  credentials: { cookie?: string; token?: string },
  method: string,
  params?: unknown,
  id: number | null = 1,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (credentials.cookie) headers.cookie = credentials.cookie;
  if (credentials.token) headers.authorization = `Bearer ${credentials.token}`;
  const response = await platformFetch(
    new Request('https://yoneda/api/v1/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    }),
    scoped,
  );
  return {
    status: response.status,
    body: response.status === 202 ? null : await response.json<any>(),
  };
}
const call = (credentials: { cookie?: string; token?: string }, name: string, args: unknown) =>
  mcp(credentials, 'tools/call', { name, arguments: args }).then((r) => r.body.result);

it('initializes and lists account tools plus every platform tool with a required repo', async () => {
  const owner = { cookie: await signup('acctlist') };
  const init = await mcp(owner, 'initialize', { protocolVersion: '2025-03-26' });
  expect(init.body.result).toMatchObject({
    protocolVersion: '2025-03-26',
    serverInfo: { name: 'yonedarepo-account' },
    capabilities: { tools: {} },
  });
  expect((await mcp(owner, 'notifications/initialized', undefined, null)).status).toBe(202);
  const listed = (await mcp(owner, 'tools/list')).body.result.tools as any[];
  expect(listed).toHaveLength(tools.length + 3);
  const names = listed.map((t) => t.name);
  expect(names.slice(0, 3)).toEqual(['repo_list', 'repo_create', 'repo_delete']);
  for (const tool of tools) expect(names).toContain(tool.name);
  for (const tool of listed.slice(3)) {
    expect(tool.inputSchema.properties.repo.type).toBe('string');
    expect(tool.inputSchema.required).toContain('repo');
  }
  // The shared schemas are extended, never mutated in place.
  expect((tools[0].inputSchema.properties as any).repo).toBeUndefined();
  expect((await mcp({}, 'tools/list')).status).toBe(401);
});

it('creates, commits, lands and reads a repository with the owner session', async () => {
  const owner = { cookie: await signup('acctowner') };
  const created = await call(owner, 'repo_create', {
    name: 'mcp-demo',
    files: [file('a.txt', 'a\n')],
    policy: { approvals: 0, required_checks: [] },
    author,
  });
  expect(created.isError).toBeUndefined();
  const id = created.structuredContent.id as string;
  expect(id).toMatch(/^r[0-9a-f]{20}$/);

  const listed = await call(owner, 'repo_list', {});
  expect(listed.structuredContent.repos.map((r: any) => r.name)).toEqual(['mcp-demo']);

  // `repo` accepts the id or the repository's name.
  const made = await call(owner, 'git_commit', {
    repo: 'mcp-demo',
    ref: 'main',
    changes: [file('a.txt', 'b\n')],
    message: 'edit a',
    author,
  });
  const sha = made.structuredContent.commit as string;
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  const landed = await call(owner, 'git_land', { repo: id, ref: 'main', commit: sha });
  expect(landed.isError).toBeUndefined();
  const read = await call(owner, 'git_cat_file', { repo: id, path: 'a.txt', ref: 'main' });
  expect(read.structuredContent.content).toBe('b\n');

  const missing = await call(owner, 'git_status', {});
  expect(missing.isError).toBe(true);
  expect(missing.content[0].text).toMatch(/repo/);
  const unknown = await call(owner, 'git_status', { repo: 'no-such-repo' });
  expect(unknown.isError).toBe(true);
  expect(unknown.content[0].text).toMatch(/^NOT_FOUND/);
  const bogus = await call(owner, 'constructor', { repo: id });
  expect(bogus.isError).toBe(true);
});

it("refuses repositories outside the caller's scope", async () => {
  const owner = { cookie: await signup('accta') };
  const other = { cookie: await signup('acctb') };
  const mine = (await call(owner, 'repo_create', { name: 'mine', files: [file('a.txt', 'a\n')], author }))
    .structuredContent.id;
  const theirs = (
    await call(other, 'repo_create', { name: 'theirs', files: [file('b.txt', 'b\n')], author })
  ).structuredContent.id;

  // Another workspace's repository: the authority refuses the session.
  const foreign = await call(owner, 'git_cat_file', { repo: theirs, path: 'b.txt', ref: 'main' });
  expect(foreign.isError).toBe(true);
  expect(foreign.content[0].text).toMatch(/^(FORBIDDEN|NOT_FOUND|UNAUTHORIZED)/);
  // Names resolve only within the caller's own repositories.
  const named = await call(owner, 'git_status', { repo: 'theirs' });
  expect(named.content[0].text).toMatch(/^NOT_FOUND/);

  // A repository token is scoped to its one repository, whichever MCP it calls.
  const minted = await api(`/repos/${mine}/tokens`, owner, {
    body: { name: 'agent', scopes: ['read', 'write'] },
  });
  const agent = { token: minted.body.token as string };
  const own = await call(agent, 'git_cat_file', { repo: mine, path: 'a.txt', ref: 'main' });
  expect(own.structuredContent.content).toBe('a\n');
  const outside = await call(agent, 'git_cat_file', { repo: theirs, path: 'b.txt', ref: 'main' });
  expect(outside.isError).toBe(true);
  const list = await call(agent, 'repo_list', {});
  expect(list.isError).toBe(true);
  expect(list.content[0].text).toMatch(/^FORBIDDEN/);
  const create = await call(agent, 'repo_create', { name: 'nope' });
  expect(create.content[0].text).toMatch(/^FORBIDDEN/);
});

it.skipIf(!hasPlatformAuth)('works with a personal access token and its repo allowlist', async () => {
  const owner = { cookie: await signup('acctpat') };
  const allowed = (await call(owner, 'repo_create', { name: 'allowed', files: [file('a.txt', 'a\n')], author, policy: { approvals: 0, required_checks: [] } }))
    .structuredContent.id;
  const denied = (await call(owner, 'repo_create', { name: 'denied', files: [file('a.txt', 'a\n')], author }))
    .structuredContent.id;
  const pat = await api('/tokens', owner, {
    body: { name: 'cloud agent', scopes: ['repo:read', 'repo:write', 'repo:land'], expires_days: 1, repos: [allowed] },
  });
  expect(pat.status).toBe(200);
  const agent = { token: pat.body.token as string };
  expect((await call(agent, 'repo_list', {})).structuredContent.repos.map((r: any) => r.id)).toEqual([allowed]);
  const made = await call(agent, 'git_commit', {
    repo: allowed,
    ref: 'main',
    changes: [file('a.txt', 'pat\n')],
    message: 'pat edit',
    author,
  });
  const sha = made.structuredContent.commit;
  expect((await call(agent, 'git_land', { repo: allowed, ref: 'main', commit: sha })).isError).toBeUndefined();
  expect((await call(agent, 'git_cat_file', { repo: allowed, path: 'a.txt', ref: 'main' })).structuredContent.content).toBe(
    'pat\n',
  );
  const outside = await call(agent, 'git_status', { repo: denied });
  expect(outside.isError).toBe(true);
  expect(outside.content[0].text).toMatch(/^FORBIDDEN/);
  // Without repo:admin, a PAT neither creates nor deletes repositories.
  expect((await call(agent, 'repo_create', { name: 'x' })).content[0].text).toMatch(/^FORBIDDEN/);
  expect((await call(agent, 'repo_delete', { repo: allowed, confirm: 'allowed' })).content[0].text).toMatch(
    /^FORBIDDEN/,
  );
});

it.skipIf(!hasPlatformAuth)('deletes a repository only with its exact name as confirmation', async () => {
  const owner = { cookie: await signup('acctdel') };
  const id = (await call(owner, 'repo_create', { name: 'doomed' })).structuredContent.id;
  const wrong = await call(owner, 'repo_delete', { repo: id, confirm: 'doomd' });
  expect(wrong.isError).toBe(true);
  expect(wrong.content[0].text).toMatch(/^INVALID_INPUT/);
  const done = await call(owner, 'repo_delete', { repo: id, confirm: 'doomed' });
  expect(done.structuredContent).toMatchObject({ deleted: true });
  expect((await call(owner, 'repo_list', {})).structuredContent.repos).toEqual([]);
});
