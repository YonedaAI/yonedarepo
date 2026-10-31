// The managed agents' token against the real platform: a landing policy requires an agent's
// check, a plain `check` token is refused it, and the agents' scopes post it under any token
// name (a reconnect renames the token). End to end through the public API.
import { expect, it } from 'vitest';
import { TOKEN_SCOPES } from '../../cloudflare/managed/config';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

it('posts a required agent check with the agents token, under any name, and with no other', async () => {
  const owner = { cookie: await signup('reqcheck') };
  const created = await api('/repos', owner, {
    body: {
      name: 'required-agent-check',
      policy: { required_checks: ['code-review'], approvals: 0 },
      files: [file('README.md', '# demo\n')],
      author,
    },
  });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const token = async (name: string, scopes: string[]) => {
    const minted = await api(`${repo}/tokens`, owner, { body: { name, scopes } });
    expect(minted.status).toBe(200);
    return { token: minted.body.token as string };
  };
  const post = async (who: { token: string }, commit: string, name = 'code-review') =>
    (await api(`${repo}/commits/${commit}/checks`, who, { body: { name, status: 'pass' } })).status;

  const writer = await token('writer', ['read', 'write', 'check']);
  const made = await api(`${repo}/commits`, writer, {
    body: { ref: 'main', changes: [file('a.txt', 'a\n')], message: 'Add a', author },
  });
  expect(made.status).toBe(200);
  const commit = made.body.commit as string;

  const plain = await token('yoneda-managed-agents', ['read', 'review', 'check']);
  expect(await post(plain, commit)).toBe(403);
  expect(await post(writer, commit)).toBe(403);

  const renamed = await token('yoneda-managed-agents-1a2b', TOKEN_SCOPES);
  expect(await post(renamed, commit)).toBe(200);
  expect(await post(renamed, commit, 'slop-review')).toBe(200);

  const shown = await api(`${repo}/commits/${commit}`, owner);
  expect(shown.body.gates).toMatchObject({ missing_checks: [], failing_checks: [] });
  const refused = await api(`${repo}/tokens`, owner, { body: { name: 'x', scopes: ['check:Bad Name'] } });
  expect(refused.status).toBe(400);
});
