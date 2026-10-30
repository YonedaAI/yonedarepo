// Creating a repository: every step of the request is accounted for in Server-Timing, also
// when one fails, so a slow or stalled create names the step responsible.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, fakeArtifacts, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const seed = (name: string) => ({ name, policy: { required_checks: [], approvals: 0 }, files: [file('README.md', `# ${name}\n`)], author });
const phases = (headers: Headers) =>
  (headers.get('server-timing') ?? '').split(', ').map((entry) => entry.split(';')[0]);

it('accounts for every step of a seeded create in Server-Timing', async () => {
  const owner = { cookie: await signup('timed') };
  const created = await api('/repos', owner, { body: { ...seed('timed'), tokens: [{ name: 'ci', scopes: ['read'] }] } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(phases(created.headers)).toEqual(
    expect.arrayContaining([
      'create.owner',
      'create.name',
      'create.store',
      'do.repo_init',
      'create.shards',
      'shard.status',
      'create.list',
      'create.tokens',
      'create.commit',
      'do.repo_import',
      'create.project',
      'create.head',
    ]),
  );
});

it('names the step that failed in Server-Timing', async () => {
  const owner = { cookie: await signup('failing') };
  const down = { ...fakeArtifacts, create: async () => Promise.reject(new Error('internal error; reference = abc123')) };
  const env = { ...scoped, ARTIFACTS: down } as unknown as Env;
  const created = await api('/repos', owner, { body: seed('failing') }, env);
  expect(created.status).toBe(500);
  expect(phases(created.headers)).toEqual(expect.arrayContaining(['create.name', 'create.store']));
});
