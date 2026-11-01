// Item 37 of the staging kit (no model): search across repositories, through everything that asks
// it. A private repository holding a word no other has, pushed with stock Git, is found by
// `GET /search`, `yoneda search --all`, the account MCP's `search_repos` and the Search page.
// The second kit account finds nothing until it is a member, and nothing again once removed.
// A token allowlisted elsewhere finds nothing, a revoked token is refused, and a repository token
// has no account to search. Then a repository beyond the 25 cap: 26 newer ones hold nothing, and
// the oldest is found all the same. The cap's repositories are deleted here, in one go.
import assert from 'node:assert/strict';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { PAT_SCOPES } from './cli-tools.mjs';
import { b64, Session, sleep } from './client.mjs';
import { author, cloneOf, kitRepo, noLeak, pushWork, refusal, settled } from './feature-kit.mjs';
import { withChrome } from './kit-chrome.mjs';
import { McpClient } from './mcp-client.mjs';

const BEYOND_CAP = 26;
const CAP = 25;
const MAX_PAGES = 4;
const AT_ONCE = 4;
const CODE = '&groups=code';
const asked = (word) => `/search?query=${encodeURIComponent(word)}${CODE}`;
const found = (answer) => answer.results.map((r) => r.repo);

/** How a search reaches the private repository: the same answer for each client. */
async function everyClient(kit, repo, word, { chrome, account }, m) {
  const api = kit.pat();
  // Search lags a landing by a moment: the directory filter and the search index are derived.
  const first = await settled(async () => {
    const answer = await api.get(asked(word));
    return found(answer).includes(repo.id) && answer;
  }, `${word} in GET /search`, 60_000);
  const hit = first.results.find((r) => r.repo === repo.id);
  assert.equal(hit.answer.results[0]?.path, 'src/needle.ts', 'the match is not the pushed file');

  const cli = await kit.yonedaOk(['search', word, '--all'], { env: kit.env(NO_SESSION) });
  const printed = `${cli.stdout}\n${cli.stderr}`;
  assert.ok(printed.includes(repo.name), `yoneda search --all does not name the repository: ${printed.slice(0, 300)}`);
  assert.ok(printed.includes('src/needle.ts'), 'yoneda search --all does not name the file');
  const both = await kit.yoneda(['search', word, '--repo', repo.id, '--all'], { env: kit.env(NO_SESSION) });
  assert.notEqual(both.code, 0, '--all with --repo is refused: it names no one repository');

  const mcp = new McpClient(`${kit.api}/api/v1/mcp`, kit.token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  assert.ok((await mcp.rpc('tools/list', {})).tools.some((t) => t.name === 'search_repos'), 'the account MCP has no search_repos');
  const viaMcp = await mcp.tool('search_repos', { query: word, groups: 'code' });
  assert.ok(viaMcp.results.some((r) => r.repo === repo.id), `search_repos: ${JSON.stringify(viaMcp).slice(0, 300)}`);

  await withChrome({ ...chrome, name: 'search' }, m, async ({ page, shot }) => {
    await page.goto(`${chrome.origin}/search?q=${encodeURIComponent(word)}`);
    const results = page.getByRole('region', { name: 'Search' });
    await see(results.getByText(/Found in 1 repository of \d+ searched\./), 'the Search page finding it');
    await see(results.getByRole('heading', { level: 2, name: repo.name }), 'the repository in the results');
    await see(results.getByText('src/needle.ts').first(), 'the file in the results');
    await shot('search-across');
  });
  m.clients = 'REST,CLI,MCP,page';
}

/** A private repository stays private, however the caller asks. */
async function privacy(kit, repo, word, credentials, m) {
  const api = kit.pat();
  const other = await credentials.second();
  const look = () => other.session.get(asked(word));
  const stranger = await look();
  assert.deepEqual(found(stranger), [], 'a stranger found a private repository');
  noLeak({ body: stranger }, repo.name, 'a stranger\'s search');
  await api.post(repo.path('/members'), { account: other.name, role: 'read' });
  await settled(async () => found(await look()).includes(repo.id), 'a member finding it', 20_000);
  await api.call('DELETE', repo.path(`/members/${other.name}`));
  await settled(async () => !found(await look()).includes(repo.id), 'a removed member losing it', 20_000);

  const elsewhere = await kitRepo(kit, 'kit-search-other');
  const narrow = await kit.platformAccount.post('/tokens', { name: 'kit-search-narrow', scopes: PAT_SCOPES, repos: [elsewhere.id], expires_days: 1 });
  const wide = await kit.platformAccount.post('/tokens', { name: 'kit-search-revoked', scopes: PAT_SCOPES, repos: null, expires_days: 1 });
  try {
    assert.deepEqual(found(await kit.pat(narrow.token).get(asked(word))), [], 'a token allowlisted elsewhere found the repository');
    const before = await kit.pat(wide.token).get(asked(word));
    assert.ok(found(before).includes(repo.id), 'the token to revoke finds it first');
  } finally {
    await kit.platformAccount.call('DELETE', `/tokens/${narrow.id}`);
    await kit.platformAccount.call('DELETE', `/tokens/${wide.id}`);
  }
  const revoked = await settled(async () => {
    const answer = await kit.pat(wide.token).raw('GET', asked(word));
    return answer.status === 401 && answer;
  }, 'the revoked token to be refused');
  noLeak(revoked, repo.name, 'the revoked token');

  const anonymous = await new Session(`${kit.api}/api/v1`).raw('GET', asked(word));
  assert.equal(anonymous.status, 401, `an anonymous search: ${refusal(anonymous)}`);
  const { token } = await api.post(repo.path('/tokens'), { name: 'kit-search-repo', scopes: ['read'] });
  try {
    const answer = await kit.pat(token).raw('GET', asked(word));
    assert.equal(answer.status, 403, `a repository token has no account to search: ${refusal(answer)}`);
  } finally {
    await api.call('DELETE', repo.path('/tokens/kit-search-repo'));
  }
  m.private = 'stranger,member,removed,allowlist,revoked,anonymous,repository token';
}

/** `count` repositories of nothing but a README, at most AT_ONCE being made at a time. */
async function padding(kit, stamp, count) {
  const made = [];
  const names = Array.from({ length: count }, (_, i) => `kit-search-pad-${stamp}-${i}`);
  const worker = async () => {
    for (let name = names.shift(); name; name = names.shift()) {
      const files = [{ path: 'README.md', content_b64: b64(`# ${name}\nnothing to find here\n`) }];
      const { id } = await kit.pat().post('/repos', { name, policy: { approvals: 0, required_checks: [] }, files, author });
      made.push({ id, name });
      // Item 17 deletes what the kit lists, should this item stop before its own cleanup.
      kit.repos.push({ id, name });
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return made;
}

/** Walks `next` as a client does; answers the pages up to the one that found `repo`. */
async function walk(api, word, repo) {
  const pages = [];
  for (let after = null; pages.length < MAX_PAGES; ) {
    const page = await api.get(`${asked(word)}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    assert.ok(page.searched <= CAP, `one page asked ${page.searched} repositories`);
    pages.push(page);
    if (found(page).includes(repo.id)) return { pages, hit: true };
    if (!page.next) return { pages, hit: false };
    after = page.next;
  }
  return { pages, hit: false };
}

/** The oldest of 27, the only one holding `word`, is found past the 25 newest: on the first page
 * once the directory has ruled the rest out, by `next` until then, and never not at all. */
async function beyondTheCap(kit, oldest, word, m) {
  const api = kit.pat();
  const pads = await padding(kit, Date.now(), BEYOND_CAP);
  try {
    const { pages, hit } = await walk(api, word, oldest);
    const said = pages.map((p) => `${p.searched}/${p.scanned}${p.next ? ' +next' : ''}`).join(', ');
    Object.assign(m, { beyond_cap_pages: pages.length, beyond_cap_searched: said });
    assert.ok(hit, `a repository past the 25 newest is not found by walking next: ${said}`);
    if (pages.length > 1) {
      const cli = await kit.yonedaOk(['search', word, '--all', '--after', pages.at(-2).next], { env: kit.env(NO_SESSION) });
      assert.ok(`${cli.stdout}\n${cli.stderr}`.includes(oldest.name), 'yoneda search --all --after does not reach it');
    }
  } finally {
    for (const { id, name } of pads) {
      const done = await kit.platformAccount.raw('DELETE', `/repos/${id}?confirm=${encodeURIComponent(name)}`);
      if (done.ok) kit.repos = kit.repos.filter((r) => r.id !== id);
      await sleep(50);
    }
  }
}

/** 37: `chrome` and `account` for the page; `credentials.second()` is the second kit account. */
export async function searchFlow(kit, { chrome, account, credentials }, m) {
  if (!kit.token) return { skip: 'No PAT (item 12)' };
  const word = `kitneedle${Date.now().toString(36)}`;
  const repo = await kitRepo(kit, 'kit-search');
  m.repo = repo.id;
  const dir = await cloneOf(kit, repo, 'search');
  await pushWork(kit, dir, { branch: 'main', message: 'Add the needle', files: { 'src/needle.ts': `export const ${word} = 1;\n` } });
  await everyClient(kit, repo, word, { chrome, account }, m);
  await privacy(kit, repo, word, credentials, m);
  await beyondTheCap(kit, repo, word, m);
}
