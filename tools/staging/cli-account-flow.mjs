// Account items of the staging kit's CLI part: the account MCP driven with the device-login
// PAT (15), server-side reads at an earlier log version (16), and cleanup through
// `yoneda repo delete` with the PAT revoked last (17). `cleanupRepos` deletes the kit
// account's leftover repositories by name prefix (`--cleanup-repos`).
import assert from 'node:assert/strict';
import { b64 } from './client.mjs';
import { PAT_SCOPES } from './cli-tools.mjs';
import { McpClient } from './mcp-flow.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const decode = (blob) => Buffer.from(blob.content ?? '', blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');

/** 15: initialize, tools/list, repo_create → git_commit → git_land → git_cat_file, allowlist. */
export async function accountMcp(kit, state, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const mcp = new McpClient(`${kit.api}/api/v1/mcp`, kit.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  const tools = (await mcp.rpc('tools/list', {})).tools.map((t) => t.name);
  metrics.tools = tools.length;
  for (const name of ['repo_list', 'repo_create', 'repo_delete', 'git_commit', 'git_land', 'git_cat_file', 'git_refs', 'git_grep'])
    assert.ok(tools.includes(name), `tools/list lacks ${name}`);
  const name = `kit-mcp-${Date.now()}`;
  let started = performance.now();
  const created = await mcp.tool('repo_create', { name, policy: { approvals: 0, required_checks: [] }, files: [{ path: 'README.md', content_b64: b64('# MCP kit\n') }], author });
  metrics.repo_create_ms = Math.round(performance.now() - started);
  assert.match(created.id ?? '', /^r[0-9a-f]{20}$/, 'repo_create returned no id');
  kit.repos.push({ id: created.id, name });
  metrics.repo = created.id;
  const text = `written through the account MCP ${Date.now()}\n`;
  started = performance.now();
  const commit = await mcp.tool('git_commit', { repo: created.id, ref: 'main', changes: [{ path: 'mcp/note.txt', content_b64: b64(text) }], message: 'Kit: account MCP commit', author });
  metrics.commit_ms = Math.round(performance.now() - started);
  assert.match(commit.commit ?? '', /^[0-9a-f]{40}$/, 'git_commit returned no commit');
  started = performance.now();
  const landed = await mcp.tool('git_land', { repo: created.id, ref: 'main', commit: commit.commit });
  metrics.land_ms = Math.round(performance.now() - started);
  assert.ok(Number.isInteger(landed.version), `git_land returned no version: ${JSON.stringify(landed).slice(0, 200)}`);
  // By name as well as id: the account MCP resolves an exact repository name.
  const read = await mcp.tool('git_cat_file', { repo: name, path: 'mcp/note.txt', min_version: landed.version });
  assert.equal(decode(read), text, 'git_cat_file did not return the landed bytes');
  metrics.round_trip = 'ok';
  // A PAT allowlisted to the MCP repository only: it reads that one, and is refused the CLI repository.
  const narrow = await kit.platformAccount.post('/tokens', { name: 'kit-mcp-allowlist', scopes: PAT_SCOPES, repos: [created.id], expires_days: 1 });
  try {
    const scoped = new McpClient(`${kit.api}/api/v1/mcp`, narrow.token);
    await scoped.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
    const own = await scoped.attempt('git_refs', { repo: created.id });
    assert.ok(own.status === 200 && !own.isError && !own.error, `The allowlisted repository was refused: ${own.text || own.error}`);
    const listed = JSON.parse((await scoped.attempt('repo_list', {})).text || '{}');
    metrics.allowlist_repo_list = listed.repos?.map((r) => r.id).join(',');
    assert.deepEqual(listed.repos?.map((r) => r.id), [created.id], 'repo_list shows repositories outside the allowlist');
    const outside = state.repo ?? kit.repos.find((r) => r.id !== created.id)?.id;
    if (!outside) return { skip: 'No second repository to test the allowlist against (item 12)' };
    const refused = await scoped.attempt('git_cat_file', { repo: outside, path: 'README.md' });
    metrics.outside_refusal = `${refused.status} ${(refused.error ?? refused.text).slice(0, 160)}`;
    assert.ok(refused.isError || refused.error || refused.status >= 400, `A repository outside the allowlist was readable: ${refused.text.slice(0, 120)}`);
    assert.ok(!refused.text.includes(state.marker ?? '\u0000'), 'The refusal leaked file content');
  } finally {
    await kit.platformAccount.call('DELETE', `/tokens/${narrow.id}`);
  }
}

/** 16: `yoneda log|grep|blame --at <v>` show the content of version v (item 12's push). */
export async function serverReads(kit, state, metrics) {
  if (!state.v12) return { skip: 'No CLI repository history (item 12)' };
  const at = ['--repo', state.repo, '--at', String(state.v12)];
  const log = await kit.yonedaOk(['log', ...at]);
  metrics.log_at = log.stdout.split('\n')[0];
  assert.ok(log.stdout.startsWith(state.commit12), `log --at ${state.v12} does not start at ${state.commit12}: ${metrics.log_at}`);
  const grep = await kit.yonedaOk(['grep', state.marker, ...at]);
  metrics.grep_at = grep.stdout;
  assert.match(grep.stdout, new RegExp(`^README\\.md:1: ${state.marker} line one$`, 'm'), `grep --at missed the marker: ${grep.stdout}`);
  const blame = await kit.yonedaOk(['blame', 'README.md', ...at]);
  assert.ok(blame.stdout.includes(state.commit12), 'blame --at does not attribute README.md to the item-12 commit');
  assert.ok(blame.stdout.includes(`${state.marker} line one`), 'blame --at lacks the version-v line');
  metrics.blame_at = 'ok';
  if (state.readmeChanged) {
    // Today's main no longer has the marker (item 13 rewrote line one): --at really travelled.
    const now = await kit.yonedaOk(['grep', state.marker, '--repo', state.repo]);
    assert.equal(now.stdout, '', `grep at head still finds the old line: ${now.stdout}`);
    const head = await kit.yonedaOk(['log', '--repo', state.repo, '--limit', '1']);
    assert.ok(!head.stdout.startsWith(state.commit12), 'log at head still starts at the item-12 commit');
    metrics.head_differs = true;
  }
  metrics.read_ms = log.ms + grep.ms + blame.ms;
}

/** 17: `yoneda repo delete` for every kit repository, reads then 404/410, PAT revoked. */
export async function cliCleanup(kit, metrics) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  metrics.deleted = [];
  for (const { id, name } of kit.repos) {
    const done = await kit.yonedaOk(['repo', 'delete', id, '--confirm', name]);
    const read = await kit.pat().raw('GET', `/repos/${id}/refs`);
    metrics.deleted.push({ id, name, ms: done.ms, read_after: `${read.status} ${read.body?.error?.code ?? ''}` });
    assert.ok([404, 410].includes(read.status), `${id} still answers ${read.status} after delete`);
  }
  kit.repos = [];
  await revokePat(kit, metrics);
}

/** Revokes the device-login PAT and checks the platform refuses it afterwards. */
export async function revokePat(kit, metrics = {}) {
  if (!kit.patId) return;
  await kit.platformAccount.call('DELETE', `/tokens/${kit.patId}`);
  const after = await kit.pat().raw('GET', '/repos');
  metrics.pat_after_revoke = after.status;
  kit.patId = null;
  assert.equal(after.status, 401, `The revoked PAT still answers ${after.status}`);
}

/** Deletes the kit account's repositories whose names start with `prefix`; returns counts. */
export async function cleanupRepos(platformAccount, prefix) {
  assert.ok(prefix.length >= 4, 'The prefix must be at least four characters');
  const result = { prefix, deleted: 0, failed: [] };
  for (;;) {
    const { repos } = await platformAccount.get('/repos');
    const matching = repos.filter((r) => r.name.startsWith(prefix) && !result.failed.some((f) => f.id === r.id));
    if (matching.length === 0) return result;
    for (const repo of matching) {
      const done = await platformAccount.raw('DELETE', `/repos/${repo.id}?confirm=${encodeURIComponent(repo.name)}`);
      if (done.ok) result.deleted += 1;
      else result.failed.push({ id: repo.id, name: repo.name, error: `${done.status} ${done.body?.error?.code ?? ''}` });
    }
  }
}
