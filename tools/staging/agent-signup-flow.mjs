// Item 46 of the staging kit (no model): agent sign-up, needing AGENT_SIGNUP=on on the platform
// Worker; while it is off the item stops at once with a note. The real `yoneda login --agent`
// waits on the real approval page; then the agent, as itself: what it may reach, what it can't
// mint, how it reviews, its limits, and signing it out. It holds the run's one session: no sign-in.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { see } from './browser-collab-flow.mjs';
import { b64, until } from './client.mjs';
import { author, kitRepo, openPage, pushWork, refusal, settled } from './feature-kit.mjs';
import { rowWith, withChrome } from './kit-chrome.mjs';
import { McpClient } from './mcp-client.mjs';

export const SIGNUP_OFF = 'AGENT_SIGNUP is off on this platform: nothing to test. Set it on in infra/envs/<env>.json and deploy.';
const PREFIX = 'kit-bot';
const LIMIT = 10;
const QUEUE_MS = 90_000;
const SCOPES = ['repo:read', 'repo:write', 'repo:review'];

const changes = (path, text, message) => ({ ref: 'main', changes: [{ path, content_b64: b64(text) }], message, author });
const review = (who, repo, commit, decision = 'approve') => who.raw('POST', repo.path(`/commits/${commit}/reviews`), { decision });

/** `yoneda login --agent <name>` in a config of its own, so the kit's login stays. */
function loginAs(kit, name) {
  const config = kit.path('agent-config', name);
  const env = kit.env({ YONEDA_TOKEN: '', XDG_CONFIG_HOME: config });
  const child = spawn(join(kit.bin, 'yoneda'), ['login', '--agent', name, '--no-browser', '--origin', kit.api], { cwd: kit.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  child.stdout.on('data', (d) => (said += d));
  child.stderr.on('data', (d) => (said += d));
  const exited = new Promise((resolve) => child.on('close', resolve));
  return {
    kill: () => child.exitCode === null && child.kill('SIGKILL'),
    /** The code it shows, or null when the platform refused it with the switch off. */
    code: () =>
      until(() => said.match(/enter the code ([A-Z]{4}-[A-Z]{4})/)?.[1] ?? (child.exitCode !== null && 'EXITED'), { timeoutMs: 30_000, intervalMs: 200, what: 'the code from yoneda login --agent' }).then((code) => {
        if (code !== 'EXITED') return code;
        assert.match(said, /Agent sign-up is off/, `yoneda login --agent exited early: ${said.slice(-300)}`);
        return null;
      }),
    /** The token it stored, once it finished; `said` is checked for who it signed in as. */
    async token() {
      const status = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 90_000))]);
      assert.equal(status, 0, `yoneda login --agent did not finish: ${status} ${said.slice(-300)}`);
      assert.match(said, new RegExp(`as agent ${name} of `), 'the CLI does not say which agent it signed in');
      return JSON.parse(readFileSync(join(config, 'yoneda', 'credentials'), 'utf8')).token;
    },
  };
}

/** An agent signed up by API, for the cases that need several. Answers its token. */
async function apiAgent(platform, name, repos, scopes = SCOPES) {
  const { user_code, device_code } = await platform.post('/device/code', { client_name: 'yoneda-cli', host: 'kit', agent: name });
  const approved = await platform.raw('POST', '/device/approve', { user_code, scopes, repos });
  assert.ok(approved.ok, `approving ${name}: ${refusal(approved)}`);
  return (await platform.post('/device/token', { device_code })).token;
}

/** Signs out every agent this item left, this run's and a failed run's. */
async function clearAgents(platform) {
  const { tokens } = await platform.get('/tokens');
  for (const token of tokens.filter((t) => t.origin?.startsWith(`agent:${PREFIX}`))) await platform.call('DELETE', `/tokens/${token.id}`);
}

/** The approval page: who asks, nothing chosen, then the person chooses. */
async function approveOnPage(web, code, name, repo, m) {
  await withChrome({ ...web.chrome, name: 'agent-signup' }, m, async ({ page, shot }) => {
    await page.goto(`${web.chrome.origin}/device?code=${code}`);
    await see(page.getByRole('heading', { name: 'Connect an agent' }), 'the agent approval page');
    await see(page.getByText(name), "the agent's name");
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    assert.equal(await approve.isDisabled(), true, 'Approve is open with no repository chosen');
    assert.equal(await page.getByRole('radio', { name: /^All repositories/ }).isChecked(), false, 'all repositories starts chosen');
    assert.equal(await page.getByRole('checkbox', { name: /^Admin/ }).count(), 0, 'Admin is offered to an agent');
    assert.equal(await page.getByRole('checkbox', { name: /^SSH keys/ }).count(), 0, 'SSH keys are offered to an agent');
    assert.equal(await page.getByRole('combobox', { name: 'Expires after' }).inputValue(), '30', 'the expiry does not start at 30 days');
    await shot('asking');
    await page.getByRole('checkbox', { name: /^Review/ }).check();
    await page.getByRole('checkbox', { name: repo.name, exact: true }).check();
    await approve.click();
    await see(page.getByText('Return to your terminal'), 'the approved note');
    await shot('approved');
  });
}

/** An actor of its own, in the API, a Git push, and on the page. */
async function asItself(kit, web, repo, token, actor, m) {
  const agent = kit.pat(token);
  assert.equal((await agent.get(repo.path())).viewer.principal, actor, 'the agent reads as another actor');
  const env = kit.env({ ...NO_SESSION, YONEDA_TOKEN: token });
  const dir = kit.path('agent-work');
  await kit.ok('git', ['clone', '-q', kit.remote(repo.id), dir], { env });
  const branch = 'kit/agent-work';
  const head = await pushWork(kit, dir, { branch, files: { 'src/agent.txt': 'an agent wrote this\n' }, message: 'Agent work', env });
  assert.equal((await kit.pat().get(repo.path(`/commits/${head}`))).principal, actor, 'the pushed commit reads as another actor');
  const { number } = await agent.post(repo.path('/changes'), { branch, title: 'Agent work' });
  await withChrome({ ...web.chrome, name: 'agent-signup-actor' }, m, async ({ page, shot }) => {
    await openPage(page, { origin: web.chrome.origin, account: web.account }, repo, `/changes/${number}`);
    await see(page.getByText(/\(agent of /), 'the agent on its Landing');
    await shot('landing');
  });
  return { dir, env, head, number };
}

async function keepsToItsRepositories(kit, token, repo, env, m) {
  m.rest_outside = (await kit.pat(token).raw('GET', repo.path())).status;
  assert.ok(m.rest_outside === 403 || m.rest_outside === 404, `REST outside its repositories: ${m.rest_outside}`);
  const mcp = new McpClient(`${kit.api}/api/v1/mcp`, token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
  const refused = await mcp.attempt('git_cat_file', { repo: repo.id, path: 'README.md' });
  assert.ok(refused.isError || refused.error || refused.status >= 400, 'MCP read outside its repositories');
  const cloned = await kit.run('git', ['clone', '-q', kit.remote(repo.id), kit.path('agent-outside')], { env });
  assert.notEqual(cloned.code, 0, 'Git cloned outside its repositories');
}

async function mintsNothing(kit, repo, token) {
  const agent = kit.pat(token);
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKitAgentSignUpNeverStoredKitAgentSignUp0000';
  const asks = [
    ['GET', '/tokens'],
    ['POST', repo.path('/tokens'), { name: 'kit-agent', scopes: ['read'] }],
    ['POST', '/ssh-keys', { title: 'kit-agent', key }],
    ['POST', '/repos', { name: `kit-agent-made-${Date.now()}` }],
  ];
  for (const [method, path, body] of asks) {
    const answer = await agent.raw(method, path, body);
    assert.equal(answer.status, 403, `${method} ${path}: ${refusal(answer)}`);
  }
  const personal = await agent.raw('POST', '/tokens', { name: 'kit-agent', scopes: ['repo:read'] });
  assert.equal(personal.status, 401, `POST /tokens: ${refusal(personal)}`);
}

/** Its owner approves and lands it; it approves neither its owner nor a sibling, and adds no
 * second approval. The sibling's commit comes through the API: the shard path. */
async function reviews(kit, repo, work, token, sibling, siblingActor) {
  const owner = kit.pat();
  const agent = kit.pat(token);
  assert.equal((await review(agent, repo, work.head)).status, 403, 'the agent approved its own push');
  const approved = await review(owner, repo, work.head);
  assert.ok(approved.ok, `the owner could not approve their agent: ${refusal(approved)}`);
  assert.equal((await agent.raw('POST', repo.path('/land'), { ref: 'main', commit: work.head })).status, 403, 'an agent without Land landed');
  await owner.post(repo.path('/land'), { ref: 'main', commit: work.head });
  await settled(async () => (await owner.get(repo.path(`/changes/${work.number}`))).status === 'landed', 'the Landing to read landed');

  const own = await owner.post(repo.path('/commits'), changes('src/owner.txt', 'mine\n', 'Owner work'));
  assert.equal((await review(agent, repo, own.commit)).status, 403, "the agent approved its owner's commit");

  const theirs = await kit.pat(sibling).post(repo.path('/commits'), changes('src/sibling.txt', 'theirs\n', 'Sibling work'));
  assert.equal((await review(agent, repo, theirs.commit)).status, 403, 'the agent approved a sibling');
  assert.ok((await review(owner, repo, theirs.commit)).ok, 'the owner could not approve the sibling');
  await owner.post(repo.path('/land'), { ref: 'main', commit: theirs.commit });
  assert.equal((await owner.get(repo.path(`/commits/${theirs.commit}`))).principal, siblingActor, 'the principal was lost landing through a shard');

  const ci = await owner.post(repo.path('/tokens'), { name: 'kit-agent-ci', scopes: ['read', 'write'] });
  const tokens = await kit.pat(ci.token).post(repo.path('/commits'), changes('src/ci.txt', 'ci\n', 'Token work'));
  for (const who of [owner, agent]) assert.ok((await review(who, repo, tokens.commit)).ok, 'a review of a token commit was refused');
  assert.equal((await owner.get(repo.path(`/commits/${tokens.commit}`))).gates.approvals, 1, 'an account and its agent counted twice');
}

/** Land when cleared takes an agent's Landing like anyone's (skipped where its switch is off). */
async function landsWhenCleared(kit, repo, work, token, m) {
  const owner = kit.pat();
  const on = await owner.raw('PUT', repo.path('/auto-landings'), { land_when_cleared: true });
  m.land_when_cleared = on.ok ? 'on' : refusal(on);
  if (!on.ok) return;
  const branch = 'kit/agent-clears';
  const head = await pushWork(kit, work.dir, { branch, files: { 'src/clears.txt': 'clears\n' }, message: 'Agent work to clear', env: work.env });
  const { number } = await kit.pat(token).post(repo.path('/changes'), { branch, title: 'Agent work to clear' });
  assert.ok((await review(owner, repo, head)).ok, 'the owner could not approve');
  await settled(async () => (await owner.get(repo.path(`/changes/${number}`))).status === 'landed', "the agent's Landing to land by itself", QUEUE_MS);
}

/** One live agent per name; ten an account, refused on the page before the code is spent;
 * signing one out on the page ends it at once and makes room. */
async function limits(kit, web, repo, name, token, m) {
  const platform = kit.platformAccount;
  const body = (user_code) => ({ user_code, scopes: ['repo:read'], repos: [repo.id] });
  const twin = await platform.post('/device/code', { client_name: 'yoneda-cli', agent: name });
  const refused = await platform.raw('POST', '/device/approve', body(twin.user_code));
  assert.equal(refused.status, 409, `a second live ${name}: ${refusal(refused)}`);

  const { tokens } = await platform.get('/tokens');
  const live = tokens.filter((t) => t.origin?.startsWith('agent:')).length;
  for (let n = live; n < LIMIT; n++) await apiAgent(platform, `${PREFIX}-fill-${n}-${Date.now() % 100000}`, [repo.id], ['repo:read']);
  m.live_agents = LIMIT;
  const late = `${PREFIX}-late-${Date.now() % 100000}`;
  const eleventh = await platform.post('/device/code', { client_name: 'yoneda-cli', agent: late });
  await withChrome({ ...web.chrome, name: 'agent-signup-limits' }, m, async ({ page, shot }) => {
    await page.goto(`${web.chrome.origin}/device?code=${eleventh.user_code}`);
    await page.getByRole('checkbox', { name: repo.name, exact: true }).check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await see(page.getByText('sign out an agent first'), 'the limit on the page');
    await shot('eleventh');
    await page.goto(`${web.chrome.origin}/settings/tokens`);
    const row = rowWith(page, 'row', `Agent ${name}`);
    await see(row, 'the agent under Signed-in CLIs');
    await shot('signed-in');
    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: `Sign out agent ${name}` }).click();
    await see(page.getByText(`Revoked ${name}`), 'the sign-out note');
    await shot('signed-out');
  });
  assert.equal((await kit.pat(token).raw('GET', repo.path())).status, 401, 'a signed-out agent still answers');
  assert.ok((await kit.pat().raw('GET', repo.path())).ok, "the kit's login stopped with its agent");
  const room = await platform.raw('POST', '/device/approve', body(eleventh.user_code));
  assert.ok(room.ok, `no room after signing one out: ${refusal(room)}`);
}

export async function agentSignup(kit, web, m) {
  const platform = kit.platformAccount;
  await clearAgents(platform);
  const stamp = Date.now() % 1_000_000;
  const name = `${PREFIX}-${stamp}`;
  const work = await kitRepo(kit, 'kit-agent', { approvals: 1 });
  const login = loginAs(kit, name);
  try {
    const code = await login.code();
    if (!code) return { skip: SIGNUP_OFF };
    await approveOnPage(web, code, name, work, m);
    const token = await login.token();
    const actor = `agent:${web.account.name}/${name}`;
    const listed = (await platform.get('/tokens')).tokens.find((t) => t.origin === `agent:${name}`);
    assert.deepEqual([listed?.name, listed?.repos], [name, [work.id]], 'the agent under the account');
    m.expires_in_days = Math.round((listed.expires_at - Date.now()) / 86_400_000);
    assert.equal(m.expires_in_days, 30, 'the default expiry');
    const pushed = await asItself(kit, web, work, token, actor, m);
    const outside = await kitRepo(kit, 'kit-agent-outside');
    await keepsToItsRepositories(kit, token, outside, pushed.env, m);
    await mintsNothing(kit, work, token);
    const siblingName = `${PREFIX}-sib-${stamp}`;
    const sibling = await apiAgent(platform, siblingName, [work.id]);
    await reviews(kit, work, pushed, token, sibling, `agent:${web.account.name}/${siblingName}`);
    await landsWhenCleared(kit, work, pushed, token, m);
    await limits(kit, web, work, name, token, m);
  } finally {
    login.kill();
    await clearAgents(platform);
  }
}
