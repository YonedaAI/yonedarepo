// Secret scanning through the public API: a commit carrying a credential is refused with
// 422 SECRET_DETECTED naming the path and line (never the secret), on the stateless and
// the authority path alike, until the owner accepts that path and rule in policy.
// The fake token is assembled at runtime so this source holds none.
import { expect, it } from 'vitest';
import { api, author, file, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const fakeToken = () => ['gh', 'p_'].join('') + 'aB3dE5gH7jK9mN1pQ'.repeat(3).slice(0, 36);

it('refuses committed credentials until the owner allows that path and rule', async () => {
  const owner = { cookie: await signup('secrets') };
  const policy = { required_checks: [], approvals: 0 };
  const created = await api('/repos', owner, { body: { name: 'leaky', policy, files: [file('README.md', '# leaky\n')], author } });
  expect(created.status).toBe(200);
  const repo = `/repos/${created.body.id}`;
  const bot = { token: (await api(`${repo}/tokens`, owner, { body: { name: 'bot', scopes: ['read', 'write'] } })).body.token as string };
  const leak = [file('src/env.ts', `export const a = 1;\nexport const token = '${fakeToken()}';\n`)];
  const commit = (auth: typeof bot | typeof owner, changes = leak) =>
    api(`${repo}/commits`, auth, { body: { ref: 'main', changes, message: 'config', author } });

  for (const auth of [bot, owner]) {
    const refused = await commit(auth);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'SECRET_DETECTED']);
    expect(refused.body.error.message).toContain('src/env.ts line 2');
    expect(refused.body.error.message).toContain('github-token');
    expect(JSON.stringify(refused.body)).not.toContain(fakeToken());
  }
  // A token cannot excuse its own leak; the owner can, for this path and rule only.
  const allowed = { ...policy, secret_allow: [{ path: 'src/env.ts', rule: 'github-token' }] };
  expect((await api(`${repo}/policy`, bot, { method: 'PUT', body: { policy: allowed } })).status).toBe(403);
  expect((await api(`${repo}/policy`, owner, { method: 'PUT', body: { policy: allowed } })).status).toBe(200);
  expect((await commit(bot)).status).toBe(200);
  const elsewhere = await commit(bot, [file('src/other.ts', fakeToken())]);
  expect(elsewhere.body.error.code).toBe('SECRET_DETECTED');
});
