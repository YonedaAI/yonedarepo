// No API answer shows a non-member the address of an account named by its email (accounts
// made before sign-up named accounts by handle): every principal reads `user:<handle>`, or
// `user:(hidden)` while the account has none, over REST and MCP, anonymous or signed in.
// Members see the stored value. Git commit data (author and committer) is exempt: a clone
// serves it anyway.
import { expect, it } from 'vitest';
import { encodeAccountIdentifier } from '../../shared/account';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { api, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
const EMAIL = 'grace.hopper@example.com';
// Git identities carry an address of their own (exempt); never the account's.
const author = { name: 'Grace', email: 'commits@git.example' };
const ADDRESS = /grace\.hopper@example\.com|user:[^"\s]*@/;

/** An account named by its address, signed in. */
async function emailAccount() {
  const token = 'e'.repeat(64);
  await workspace(bindings, EMAIL, {
    op: 'signup',
    username: EMAIL,
    password: 'long platform test password',
    salt: '01'.repeat(16),
    session_hash: await sha(token),
    recovery_hash: 'b'.repeat(64),
  });
  return `yoneda_account=${encodeAccountIdentifier(EMAIL)}.${token}`;
}

/** A public repository with a principal on every kind of record a reader sees. */
async function publicRepository(cookie: string) {
  const owner = { cookie };
  const step = async (what: string, pending: Promise<{ status: number; body: any }>) => {
    const answer = await pending;
    expect(answer.status, `${what}: ${JSON.stringify(answer.body)}`).toBe(200);
    return answer.body;
  };
  const made = await api('/repos', owner, {
    body: { name: 'public-data', visibility: 'public', policy: { required_checks: [], approvals: 1 }, files: [file('a.txt', 'a\n')], author },
  }, local);
  expect(made.status).toBe(200);
  const repo = `/repos/${made.body.id}`;
  const main = made.body.commit as string;
  // Another author's commit, so the owner may review it.
  const agent = { token: (await step('tokens', api(`${repo}/tokens`, owner, { body: { name: 'agent', scopes: ['read', 'write'] } }, local))).token as string };
  const head = (await api(`${repo}/commits`, agent, { body: { parent: main, base_version: 1, changes: [file('b.txt', 'b\n')], message: 'b', author } }, local)).body.commit as string;
  await step('branches', api(`${repo}/branches`, owner, { body: { ref: 'fix', commit: head, expected: null } }, local));
  await step('changes', api(`${repo}/changes`, owner, { body: { branch: 'fix', title: 'Add b' } }, local));
  await step('changes', api(`${repo}/changes/1/comments`, owner, { body: { body: 'Looks fine.' } }, local));
  await step('commits', api(`${repo}/commits/${head}/reviews`, owner, { body: { decision: 'approve' } }, local));
  await step('commits', api(`${repo}/commits/${main}/sessions`, owner, { body: { cli: 'claude-code', summary: 'made a' } }, local));
  await step('tags', api(`${repo}/tags`, owner, { body: { name: 'v1', commit: main, message: 'First' } }, local));
  await step('releases', api(`${repo}/releases`, owner, { body: { tag: 'v1', title: 'First', notes: 'n' } }, local));
  return { id: made.body.id as string, repo, main, head };
}

/** Every public read of the repository, over REST (as `auth`) and, signed in, over MCP. */
async function crawl(id: string, main: string, head: string, auth: { cookie?: string }) {
  const repo = `/repos/${id}`;
  const paths = [
    repo, `${repo}/refs`, `${repo}/log?ref=main`, `${repo}/log?ref=fix`, `${repo}/txlog`, `${repo}/changelog`,
    `${repo}/commits/${main}`, `${repo}/commits/${head}`, `${repo}/commits/${main}/sessions`, `${repo}/sessions`,
    `${repo}/changes`, `${repo}/changes/1`, `${repo}/releases`, `${repo}/releases/v1`, `${repo}/tags/v1`,
    `${repo}/tree`, `${repo}/blob?path=a.txt`, `${repo}/blame?path=a.txt`, `${repo}/diff?head=${head}`,
    `${repo}/history?path=a.txt`, `${repo}/activity`, `/explore`,
  ];
  const answers: string[] = [];
  let ok = 0;
  for (const path of paths) {
    const answer = await api(path, auth, {}, local);
    if (answer.status === 200) ok++;
    answers.push(`${path} ${JSON.stringify(answer.body)}`);
  }
  if (auth.cookie) {
    const tools: [string, object][] = [
      ['git_status', {}], ['git_log', { ref: 'main' }], ['git_show', { commit: head }], ['git_txlog', {}],
      ['git_change_list', {}], ['git_change_show', { number: 1 }], ['git_sessions', { commit: main }],
      ['git_release_list', {}], ['git_release_show', { tag: 'v1' }],
    ];
    for (const [name, args] of tools) {
      const response = await platformFetch(
        new Request(`https://yoneda/api/v1/repos/${id}/mcp`, {
          method: 'POST',
          headers: { cookie: auth.cookie, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        }),
        local,
      );
      const body = await response.text();
      if (!body.includes('"isError":true')) ok++;
      answers.push(`mcp ${name} ${body}`);
    }
  }
  return { ok, text: answers.join('\n') };
}

it("shows a non-member no account's address in any API answer, and a member the stored one", async () => {
  const cookie = await emailAccount();
  const { id, main, head } = await publicRepository(cookie);
  const outsider = await signup('outsider_reader');

  for (const [who, auth] of [['anonymous', {}], ['outsider', { cookie: outsider }]] as const) {
    const seen = await crawl(id, main, head, auth);
    expect(seen.ok, who).toBeGreaterThan(15);
    expect(seen.text.match(ADDRESS)?.[0] ?? null, who).toBeNull();
    // Until it has a handle, the account reads as hidden.
    expect(seen.text, who).toContain('user:(hidden)');
  }
  // The owner (a member) sees the stored principal.
  expect((await crawl(id, main, head, { cookie })).text).toContain(`user:${EMAIL}`);

  // With a handle, it reads by handle.
  const picked = await platformFetch(
    new Request('https://yoneda/api/auth/handle', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'grace' }) }),
    local,
  );
  expect(picked.status).toBe(200);
  const named = await crawl(id, main, head, { cookie: outsider });
  expect(named.text.match(ADDRESS)?.[0] ?? null).toBeNull();
  expect(named.text).toContain('user:grace');
  expect(named.text).not.toContain('user:(hidden)');
});
