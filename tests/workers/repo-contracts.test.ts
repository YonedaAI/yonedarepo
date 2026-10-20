// Contracts tied to symbols and dual views over one source (paper §7.2-7.3): derived
// contracts from signatures and doc comments, authored records bound to a commit and
// node digest (stale, never silently served, once the symbol changes), the agent view's
// neighbors and the human view's narrative — all revision-bound and grant-scoped.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const RETRY = `/// Retries an operation with backoff.
///
/// # Errors
/// - when every attempt fails
pub fn retry(times: u32) -> Result<u32, RetryError> {
    backoff(times)
}

/// Delay before the next attempt.
pub fn backoff(n: u32) -> Result<u32, RetryError> {
    Ok(n * 2)
}

pub struct RetryError;
`;
const CLIENT = `/**
 * Loads a user by id.
 * @param id - the user id
 * @throws {NotFound} when the id is unknown
 */
export async function loadUser(id: string): Promise<string> {
  return formatName(id);
}

export function formatName(name: string): string {
  return name.trim();
}
`;
const APP = "import { loadUser } from './client';\nexport function main() {\n  return loadUser('1');\n}\n";
const KEYS = "export function rotateKey(): string {\n  return formatName('hunter2');\n}\n";

async function setup(name: string) {
  const owner = { cookie: await signup(name) };
  const files = [file('src/retry.rs', RETRY), file('web/client.ts', CLIENT), file('web/app.ts', APP), file('secret/keys.ts', KEYS)];
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const mint = async (scopes: string[], paths?: string[]) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name: `t${scopes.length}${paths ? 'p' : ''}`, scopes, paths } })).body.token as string });
  return { owner, id: created.body.id as string, repo, bot: await mint(['read', 'write', 'land']), mint };
}

async function mcp(repo: string, token: string, name: string, args: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/api/v1/repos/${repo}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    scoped,
  );
  return (await response.json<any>()).result;
}

it('derives contracts, records authored ones and reports them stale once the symbol changes', async () => {
  const { repo, bot } = await setup('contracts');
  const retry = await api(`${repo}/contract?path=src/retry.rs&symbol=retry`, bot);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({
    status: 'derived',
    contract: {
      summary: 'Retries an operation with backoff.',
      inputs: [{ name: 'times', type: 'u32' }],
      outputs: [{ type: 'Result<u32, RetryError>' }],
      errors: [{ kind: 'error', type: 'RetryError', description: 'when every attempt fails' }],
    },
  });
  const load = await api(`${repo}/contract?path=web/client.ts&symbol=loadUser`, bot);
  expect(load.body.contract).toMatchObject({
    summary: 'Loads a user by id.',
    inputs: [{ name: 'id', type: 'string', description: 'the user id' }],
    outputs: [{ type: 'Promise<string>' }],
    effects: ['async'],
    errors: [{ kind: 'throw', type: 'NotFound', description: 'when the id is unknown' }],
  });

  // Authored: bound to the handle's commit and the symbol's node digest.
  const backoff = await api(`${repo}/symbol?path=src/retry.rs&symbol=backoff`, bot);
  const authored = { summary: 'Doubles n.', invariants: ['the result is even'] };
  const recorded = await api(`${repo}/contracts`, bot, { body: { handle: backoff.body.handle, contract: authored } });
  expect(recorded.status).toBe(200);
  expect(recorded.body).toMatchObject({ commit: backoff.body.handle.commit, node_digest: backoff.body.handle.digest, already: false });
  const before = await api(`${repo}/contract?path=src/retry.rs&symbol=backoff`, bot);
  expect(before.body).toMatchObject({ status: 'authored', contract: authored, authored: { commit: backoff.body.handle.commit } });
  const tampered = await api(`${repo}/contracts`, bot, { body: { handle: { ...backoff.body.handle, digest: 'f'.repeat(64) }, contract: authored } });
  expect([tampered.status, tampered.body.error.code]).toEqual([409, 'STALE_HANDLE']);
  const invalid = await api(`${repo}/contracts`, bot, { body: { handle: backoff.body.handle, contract: { summary: 'x', unknown: 1 } } });
  expect(invalid.body.error.code).toBe('INVALID_INPUT');
  const pinned = (await api(`${repo}`, bot)).body.version as number;

  // Someone changes backoff and lands it: the record is stale at head, never served.
  const changed = await api(`${repo}/commits`, bot, { body: { ref: 'main', changes: [file('src/retry.rs', RETRY.replace('n * 2', 'n * 3'))], message: 'triple', author } });
  expect((await api(`${repo}/land`, bot, { body: { ref: 'main', commit: changed.body.commit } })).body.landed).toBe(true);
  const stale = await api(`${repo}/contract?path=src/retry.rs&symbol=backoff`, bot);
  expect(stale.body.status).toBe('stale');
  expect(stale.body.contract).toBeNull();
  expect(stale.body.stale.contract).toMatchObject(authored);
  expect(stale.body.derived.summary).toBe('Delay before the next attempt.');
  // retry did not change, so it is unaffected; time travel still sees the authored record.
  expect((await api(`${repo}/contract?path=src/retry.rs&symbol=retry`, bot)).body.status).toBe('derived');
  expect((await api(`${repo}/contract?path=src/retry.rs&symbol=backoff&at=${pinned}`, bot)).body.status).toBe('authored');
  // A contract written against the old handle binds to the old node: still stale at head.
  await api(`${repo}/contracts`, bot, { body: { handle: backoff.body.handle, contract: { summary: 'Old.' } } });
  expect((await api(`${repo}/contract?path=src/retry.rs&symbol=backoff`, bot)).body.status).toBe('stale');
  // Re-authoring against the current symbol makes it authoritative again, over MCP too.
  const fresh = await mcp(repo.slice(7), bot.token, 'symbol_contract', { path: 'src/retry.rs', symbol: 'backoff' });
  const rerecorded = await mcp(repo.slice(7), bot.token, 'symbol_contract_record', { handle: fresh.structuredContent.handle, contract: { summary: 'Triples n.' } });
  expect(rerecorded.isError).toBeUndefined();
  expect((await mcp(repo.slice(7), bot.token, 'symbol_contract', { path: 'src/retry.rs', symbol: 'backoff' })).structuredContent).toMatchObject({ status: 'authored', contract: { summary: 'Triples n.' } });
});

it('builds the agent and human views from one revision', async () => {
  const { id, repo, bot } = await setup('views');
  const view = await api(`${repo}/views/agent?path=web/client.ts&symbol=formatName`, bot);
  expect(view.status).toBe(200);
  expect(view.body.symbol).toMatchObject({ path: 'web/client.ts', symbol_path: 'formatName' });
  expect(view.body.symbol.source).toBe('export function formatName(name: string): string {\n  return name.trim();\n}');
  expect(view.body.contract.status).toBe('derived');
  const callers = view.body.neighbors.callers.map((n: any) => `${n.path}#${n.symbol_path}`);
  expect(callers).toEqual(['secret/keys.ts#rotateKey', 'web/client.ts#loadUser']);
  const load = await mcp(id, bot.token, 'symbol_view', { path: 'web/client.ts', symbol: 'loadUser' });
  expect(load.structuredContent.neighbors.callees.map((n: any) => n.symbol_path)).toEqual(['formatName']);
  expect(load.structuredContent.neighbors.callers.map((n: any) => n.path)).toEqual(['web/app.ts']);
  // Neighbor handles work with the other symbol tools.
  const callee = load.structuredContent.neighbors.callees[0];
  expect((await api(`${repo}/contracts`, bot, { body: { handle: callee.handle, contract: { summary: 'Trims a name.' } } })).status).toBe(200);

  const human = await api(`${repo}/views/human`, bot);
  expect(human.status).toBe(200);
  expect(human.body.subsystems.map((s: any) => s.path)).toEqual(['secret', 'src', 'web']);
  const web = human.body.subsystems.find((s: any) => s.path === 'web');
  expect(web.narrative[0]).toBe('`web` holds 2 source files (2 TypeScript) with 3 symbols: 3 functions.');
  expect(web.narrative.join('\n')).toContain('Used by `secret` (1 reference). Entry points from outside: `formatName`.');
  expect(web.narrative.join('\n')).toContain('`formatName` (2 references): Trims a name;');
  expect(web.contracts).toMatchObject({ authored: 1 });
  expect(human.body.dependency_map.edges).toEqual([{ from: 'secret', to: 'web', references: 1 }]);
  expect((await api(`${repo}/views/human`, bot)).body).toEqual(human.body);

  // Revision-bound: after a change lands, the past version still reads as it was.
  const pinned = human.body.version as number;
  const changed = await api(`${repo}/commits`, bot, { body: { ref: 'main', changes: [file('web/app.ts', 'export function main() {\n  return 1;\n}\n')], message: 'decouple', author } });
  await api(`${repo}/land`, bot, { body: { ref: 'main', commit: changed.body.commit } });
  const now = await api(`${repo}/views/agent?path=web/client.ts&symbol=loadUser`, bot);
  expect(now.body.neighbors.callers).toEqual([]);
  const then = await api(`${repo}/views/agent?path=web/client.ts&symbol=loadUser&at=${pinned}`, bot);
  expect(then.body.neighbors.callers.map((n: any) => n.path)).toEqual(['web/app.ts']);
  expect((await api(`${repo}/views/human?path=web&at=${pinned}`, bot)).body.commit).toBe(human.body.commit);
  const missing = await api(`${repo}/views/agent?path=web/client.ts&symbol=nothing`, bot);
  expect(missing.status).toBe(404);
});

it('keeps contracts and views inside a directory grant', async () => {
  const { owner, repo, mint } = await setup('scopedviews');
  // The owner warms every facts cache and records a contract on the hidden side first.
  expect((await api(`${repo}/views/human`, owner)).status).toBe(200);
  const hidden = await api(`${repo}/symbol?path=secret/keys.ts&symbol=rotateKey`, owner);
  await api(`${repo}/contracts`, owner, { body: { handle: hidden.body.handle, contract: { summary: 'Rotates hunter2.' } } });
  const web = await mint(['read', 'write'], ['web/']);

  const forbidden = async (path: string, body?: unknown) => {
    const result = await api(path, web, body ? { body } : {});
    expect(result.status, path).toBe(403);
    expect(result.body.error.message).toBe('Path is outside your grant');
  };
  await forbidden(`${repo}/contract?path=secret/keys.ts&symbol=rotateKey`);
  await forbidden(`${repo}/contract?path=secret/missing.ts&symbol=x`);
  await forbidden(`${repo}/views/agent?path=secret/keys.ts&symbol=rotateKey`);
  await forbidden(`${repo}/views/human?path=secret`);
  await forbidden(`${repo}/contracts`, { handle: hidden.body.handle, contract: { summary: 'x' } });

  // Hidden files never enter the graph: no hidden callers, subsystems, edges or counts.
  const view = await api(`${repo}/views/agent?path=web/client.ts&symbol=formatName`, web);
  expect(view.body.neighbors.callers.map((n: any) => n.path)).toEqual(['web/client.ts']);
  const human = await api(`${repo}/views/human`, web);
  expect(human.body.subsystems.map((s: any) => s.path)).toEqual(['web']);
  expect(human.body.dependency_map.edges).toEqual([]);
  expect(human.body.files_analyzed).toBe(2);
  for (const body of [view.body, human.body]) {
    const text = JSON.stringify(body);
    for (const leak of ['secret', 'rotateKey', 'hunter2', 'Rotates']) expect(text).not.toContain(leak);
  }
});
