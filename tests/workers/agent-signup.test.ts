// Agent sign-up through the platform's public API: `yoneda login --agent <name>` on the device
// flow, behind AGENT_SIGNUP. An agent is a named personal token: an actor of its own, narrower
// than a login, and revoked like one. Every other token works as it always has.
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { issuePat } from '../../cloudflare/worker/repo-pat';
import { forViewer } from '../../cloudflare/worker/repo-principal-privacy';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const DAY = 24 * 60 * 60 * 1000;
const on = { ...scoped, AGENT_SIGNUP: 'on' } as unknown as Env;
const compact = (code: string) => code.replace('-', '');

async function repo(cookie: string, name: string) {
  const created = await api('/repos', { cookie }, { body: { name, files: [file('README.md', `# ${name}\n`)], author } });
  expect(created.status).toBe(200);
  return created.body.id as string;
}
async function ask(name: string, host: string | null = 'ci-1') {
  const started = await api('/device/code', {}, { body: { client_name: 'yoneda-cli', host, agent: name } }, on);
  expect(started.status).toBe(200);
  return started.body as { device_code: string; user_code: string };
}
/** Redeems an approved code, past the poll interval. */
async function redeem(code: { device_code: string; user_code: string }) {
  await runInDurableObject(bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(`device:${compact(code.user_code)}`)), async (_i, state) => {
    state.storage.sql.exec('UPDATE device_codes SET last_poll_at=NULL');
  });
  return api('/device/token', {}, { body: { device_code: code.device_code } }, on);
}
async function agent(cookie: string, name: string, grant: Record<string, unknown>) {
  const code = await ask(name);
  const approved = await api('/device/approve', { cookie }, { body: { user_code: code.user_code, scopes: ['repo:read', 'repo:write'], ...grant } }, on);
  expect(approved.status).toBe(200);
  const redeemed = await redeem(code);
  expect(redeemed.status).toBe(200);
  return redeemed.body;
}

it('is off unless the switch is on, and a plain login never notices', async () => {
  const refused = await api('/device/code', {}, { body: { client_name: 'yoneda-cli', agent: 'bot' } });
  expect(refused.status).toBe(400);
  expect(refused.body.error.code).toBe('NOT_SUPPORTED');
  const cookie = await signup('agent_off');
  const plain = await api('/device/code', {}, { body: { client_name: 'yoneda-cli' } });
  expect(plain.status).toBe(200);
  const pending = await api(`/device/pending?code=${plain.body.user_code}`, { cookie });
  expect(pending.status).toBe(200);
  expect(pending.body).toEqual({ agent: null, host: null });
});

it('shows the signed-in person what is asking, and nobody else', async () => {
  const cookie = await signup('agent_page');
  const code = await ask('review-bot');
  const path = `/device/pending?code=${code.user_code}`;
  expect((await api(path, {}, {}, on)).status).toBe(401);
  const shown = await api(path, { cookie }, {}, on);
  expect(shown.status).toBe(200);
  expect(shown.body).toEqual({ agent: 'review-bot', host: 'ci-1' });
  expect((await api('/device/pending?code=BCDF-GHJK', { cookie }, {}, on)).status).toBe(404);
  expect((await api('/device/pending?code=nope', { cookie }, {}, on)).status).toBe(400);
});

it('a raw client cannot name itself an agent, or pass a bad name', async () => {
  for (const body of [{ client_name: 'agent:bot' }, { client_name: 'yoneda-cli', agent: 'Bad/Name' }])
    expect((await api('/device/code', {}, { body }, on)).status).toBe(400);
});

it('starts with no repository chosen and thirty days', async () => {
  const cookie = await signup('agent_scope');
  const id = await repo(cookie, 'one');
  const refused = await ask('nothing-chosen');
  for (const body of [{}, { repos: null }, { repos: [] }])
    expect((await api('/device/approve', { cookie }, { body: { user_code: refused.user_code, scopes: ['repo:read'], ...body } }, on)).status).toBe(400);
  const before = Date.now();
  const issued = await agent(cookie, 'chosen', { repos: [id] });
  expect(issued).toMatchObject({ repos: [id], account: 'agent_scope' });
  expect(new Date(issued.expires_at).getTime() || issued.expires_at).toBeGreaterThanOrEqual(before + 29 * DAY);
  const everywhere = await agent(cookie, 'everywhere', { all_repos: true });
  expect(everywhere.repos).toBeNull();
  const tooLong = await ask('too-long');
  expect((await api('/device/approve', { cookie }, { body: { user_code: tooLong.user_code, scopes: ['repo:read'], repos: [id], expires_days: 91 } }, on)).status).toBe(400);
  const ninety = await agent(cookie, 'ninety', { repos: [id], expires_days: 90 });
  expect(ninety.token).toMatch(/^ypat_/);
});

it('reads as an actor of its own, under its owner', async () => {
  const cookie = await signup('agent_actor');
  const id = await repo(cookie, 'work');
  const { token } = await agent(cookie, 'bot', { repos: [id] });
  const status = await api(`/repos/${id}`, { token });
  expect(status.status).toBe(200);
  expect(status.body.viewer.principal).toBe('agent:agent_actor/bot');
  const pushed = await api(`/repos/${id}/commits`, { token }, { body: { ref: 'main', changes: [file('a.txt', 'a\n')], message: 'x', author } });
  expect(pushed.status).toBe(200);
  const commit = await api(`/repos/${id}/commits/${pushed.body.commit}`, { cookie });
  expect(commit.body.principal).toBe('agent:agent_actor/bot');
  expect((await api(`/repos/${id}`, { cookie })).body.viewer.principal).toBe('user:agent_actor');
});

it('keeps to its repositories', async () => {
  const cookie = await signup('agent_allow');
  const [one, two] = [await repo(cookie, 'one'), await repo(cookie, 'two')];
  const { token } = await agent(cookie, 'bot', { repos: [one] });
  expect((await api(`/repos/${one}`, { token })).status).toBe(200);
  expect((await api(`/repos/${two}`, { token })).status).not.toBe(200);
});

it('cannot mint a token or an SSH key, by any route', async () => {
  const cookie = await signup('agent_mint');
  const id = await repo(cookie, 'work');
  const code = await ask('greedy');
  for (const scopes of [['repo:admin'], ['repo:read', 'account:ssh-keys']])
    expect((await api('/device/approve', { cookie }, { body: { user_code: code.user_code, scopes, repos: [id] } }, on)).status).toBe(400);
  const { token } = await agent(cookie, 'bot', { all_repos: true, scopes: ['repo:read', 'repo:write', 'repo:land', 'repo:review'] });
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1pQ1';
  const asked = [
    await api('/tokens', { token }),
    await api(`/repos/${id}/tokens`, { token }, { body: { name: 'x', scopes: ['read'] } }),
    await api('/ssh-keys', { token }, { body: { title: 'x', key } }),
    await api('/ssh-keys', { token }),
    await api('/repos', { token }, { body: { name: 'made', tokens: [{ name: 'x', scopes: ['read'] }] } }),
  ];
  for (const answer of asked) expect(answer.status).toBe(403);
  // Only a signed-in person issues personal tokens.
  expect((await api('/tokens', { token }, { body: { name: 'x', scopes: ['repo:read'] } })).status).toBe(401);
});

it('holds ten live agents, and says so before the code is spent', async () => {
  const cookie = await signup('agent_ten');
  const id = await repo(cookie, 'work');
  const issued = [];
  for (let n = 0; n < 10; n++)
    issued.push(await issuePat(on, 'agent_ten', { name: `bot-${n}`, scopes: ['repo:read'], repos: [id] }, { origin: `agent:bot-${n}`, host: null }));
  const code = await ask('eleventh');
  const body = { user_code: code.user_code, scopes: ['repo:read'], repos: [id] };
  const refused = await api('/device/approve', { cookie }, { body }, on);
  expect(refused.status).toBe(409);
  expect(refused.body.error.message).toContain('Signed-in CLIs');
  expect((await api(`/tokens/${issued[0].id}`, { cookie }, { method: 'DELETE' })).status).toBe(200);
  expect((await api('/device/approve', { cookie }, { body }, on)).status).toBe(200);
  expect((await redeem(code)).status).toBe(200);
});

it('refuses a second live agent of one name, and is revoked from the owner\'s tokens', async () => {
  const cookie = await signup('agent_revoke');
  const id = await repo(cookie, 'work');
  const { token } = await agent(cookie, 'bot', { repos: [id] });
  const twin = await ask('bot');
  expect((await api('/device/approve', { cookie }, { body: { user_code: twin.user_code, scopes: ['repo:read'], repos: [id] } }, on)).status).toBe(409);
  const listed = await api('/tokens', { cookie });
  const row = listed.body.tokens.find((t: any) => t.origin === 'agent:bot');
  expect(row).toMatchObject({ name: 'bot', host: 'ci-1', repos: [id] });
  expect((await api(`/tokens/${row.id}`, { cookie }, { method: 'DELETE' })).status).toBe(200);
  expect((await api(`/repos/${id}`, { token })).status).toBe(401);
});

it('a token that is not an agent reads and works as before, also with the switch on', async () => {
  const cookie = await signup('agent_old');
  const id = await repo(cookie, 'work');
  const website = await api('/tokens', { cookie }, { body: { name: 'laptop', scopes: ['repo:admin'] } });
  const login = await issuePat(scoped, 'agent_old', { name: 'yoneda-cli', scopes: ['repo:read', 'repo:admin'] }, { origin: 'login', host: 'mbp' });
  for (const target of [scoped, on])
    for (const token of [website.body.token, login.token]) {
      const status = await api(`/repos/${id}`, { token }, {}, target);
      expect(status.status).toBe(200);
      expect(status.body.viewer.principal).toBe('user:agent_old');
      expect((await api('/tokens', { token }, {}, target)).status).toBe(200);
    }
});

it('an agent already signed up keeps working when the switch goes off', async () => {
  const cookie = await signup('agent_kept');
  const id = await repo(cookie, 'work');
  const { token } = await agent(cookie, 'bot', { repos: [id] });
  const status = await api(`/repos/${id}`, { token });
  expect(status.body.viewer.principal).toBe('agent:agent_kept/bot');
  const pending = await ask('late');
  expect((await api('/device/approve', { cookie }, { body: { user_code: pending.user_code, scopes: ['repo:read'], repos: [id] } })).status).toBe(400);
});

it('never shows a non-member the address in an agent of an email-named account', async () => {
  const value = { principal: 'agent:ada@example.com/bot', owner: 'user:ada@example.com' };
  const read = (viewer: unknown) => forViewer(on, value, async () => ({ viewer }));
  expect(await read({ public: true })).toEqual({ principal: 'agent:(hidden)/bot', owner: 'user:(hidden)' });
  expect(await read({ public: false })).toEqual(value);
});
