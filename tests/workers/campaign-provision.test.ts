import { evictDurableObject, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { projectPlatform } from '../../cloudflare/worker/agents-platform';
import { provisionCampaignProject } from '../../cloudflare/worker/campaign-provision';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Principal } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';
import { interceptPlatform, operator, platformJson, templateArtifacts } from './platform-fixture';

const bindings = env as unknown as Env;
const admin = { role: 'admin' as const, workspace: '_admin' };
const template = 'yoneda-booking-campaign-starter-20261012';
afterEach(reset);
async function reviewer(owner = 'reviewer') {
  await workspace(bindings, owner, {
    op: 'signup',
    username: owner,
    password: 'long local test password',
    salt: '01'.repeat(16),
    recovery_hash: 'b'.repeat(64),
    session_hash: 'c'.repeat(64),
  });
  await workspace(bindings, owner, {
    op: 'reviewer_configure',
    repo_id: `old-${owner}`,
    expires: Date.now() + 86_400_000,
  });
}
/** The operator-published starter (real Git ids); the platform repository is real. */
async function artifacts() {
  const templates = await templateArtifacts({
    [template]: { 'README.md': '# Booking starter\n', 'public/index.html': '<!doctype html><title>Booking</title>\n' },
  });
  const snapshot = await templates.snapshot(template);
  const missing = () => Object.assign(new Error('Missing'), { code: 'NOT_FOUND' });
  const get = vi.fn(async (name: string): Promise<any> => {
    if (name !== template) throw missing();
    return templates.get(name);
  });
  const fake = { ...bindings, ARTIFACTS: { get } } as unknown as Env;
  return { fake, get, commit: snapshot.commit, tree: snapshot.root };
}
const provision = (env: Env, owner: string, body: Json, principal: Principal = admin) =>
  provisionCampaignProject(env, operator(), principal, owner, body);
const listed = async () =>
  (await bindings.INDEX.prepare('SELECT COUNT(*) AS n FROM platform_repos').first<{ n: number }>())?.n;
const input = (repo_id = 'fresh-campaign') => ({ repo_id, template, policy: sitePolicy });

it('seeds exact private starters and durably lists seven fresh reviewer projects without starting runs', async () => {
  await reviewer();
  const { fake, commit, tree } = await artifacts();
  for (let n = 0; n < 7; n++) {
    const repo = n ? `fresh-study-${n}` : 'fresh-campaign';
    expect(await provision(fake, 'reviewer', input(repo))).toMatchObject({
      username: 'reviewer',
      repo_id: repo,
      status: 'ready',
      commit,
    });
    const snapshot = await ledger(bindings, repo, { op: 'snapshot', _workspace: 'reviewer' });
    const platform = await projectPlatform(bindings, 'reviewer', repo);
    const head = (await platform.call('GET', '/refs')).refs['refs/heads/main'];
    expect((await platform.call('GET', `/commits/${head}`)).tree).toBe(tree);
    expect(snapshot.repository).toMatchObject({
      workspace: 'reviewer',
      head_commit: head,
      platform_repo: platform.repo,
      remote: { namespace: 'platform', name: repo, branch: 'main' },
    });
    expect(snapshot.runs).toEqual([]);
  }
  expect(await listed()).toBe(7);
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toHaveLength(7);
  expect((await workspace(bindings, 'reviewer', { op: 'reviewer_status' })).repo_id).toBe(
    'old-reviewer',
  );
});

it('rejects a nonadministrator before all Artifacts reads and state writes', async () => {
  const { fake, get } = await artifacts();
  await expect(
    provision(fake, 'reviewer', input(), { role: 'user', workspace: 'reviewer' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(get).not.toHaveBeenCalled();
});

it('replays the same reservation but rejects policy, template and workspace substitution', async () => {
  await reviewer();
  await reviewer('other');
  const { fake } = await artifacts();
  const result = await provision(fake, 'reviewer', input());
  expect(await provision(fake, 'reviewer', input())).toEqual(result);
  expect(await listed()).toBe(1);
  for (const [owner, body] of [
    ['reviewer', { ...input(), policy: { ...sitePolicy, version: 'changed' } }],
    ['reviewer', { ...input(), template: 'another-starter' }],
    ['other', input()],
  ] as const) {
    await expect(provision(fake, owner, body)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  expect(await listed()).toBe(1);
});

it('recovers a lost platform acknowledgment and survives authority eviction', async () => {
  await reviewer();
  const { fake } = await artifacts();
  let lost = false;
  // The platform creates the repository but its response never arrives.
  const local = interceptPlatform(fake, async (path, request) => {
    if (path !== '/repos' || request.method !== 'POST' || lost) return undefined;
    lost = true;
    await bindings.SELF.fetch(request);
    return platformJson({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Lost acknowledgment' } }, 502);
  });
  await expect(provision(local, 'reviewer', input())).rejects.toMatchObject({ code: 'SETUP_FAILED' });
  expect((await provision(local, 'reviewer', input())).status).toBe('ready');
  await evictDurableObject(bindings.REPOSITORIES.getByName('fresh-campaign'));
  await evictDurableObject(bindings.WORKSPACES.getByName('account:reviewer'));
  expect((await provision(local, 'reviewer', input())).status).toBe('ready');
  // The unacknowledged repository stays unbound; the project uses only the bound one.
  expect(await listed()).toBe(2);
  const bound = await workspace(bindings, 'reviewer', { op: 'project_get', id: 'fresh-campaign' });
  expect((await ledger(bindings, 'fresh-campaign', { op: 'repository_status' })).platform_repo).toBe(bound.platform.repo);
});

it('fences concurrent provisioning to one target and one workspace project', async () => {
  await reviewer();
  const { fake, commit } = await artifacts();
  const results = await Promise.all([provision(fake, 'reviewer', input()), provision(fake, 'reviewer', input())]);
  expect(results.map((r) => r.commit)).toEqual([commit, commit]);
  expect((await provision(fake, 'reviewer', input())).status).toBe('ready');
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toHaveLength(1);
  // Concurrent seeds may both reach the platform; the first binding is the only one used.
  const bound = await workspace(bindings, 'reviewer', { op: 'project_get', id: 'fresh-campaign' });
  expect((await ledger(bindings, 'fresh-campaign', { op: 'repository_status' })).platform_repo).toBe(bound.platform.repo);
});

it('rejects foreign existing repositories and invalid policies before any seed', async () => {
  await reviewer();
  const { fake } = await artifacts();
  await ledger(bindings, 'fresh-campaign', { op: 'init', id: 'fresh-campaign', name: 'Foreign', workspace: 'reviewer',
    remote: { namespace: 'platform', name: 'fresh-campaign', branch: 'main' }, commit: 'a'.repeat(40), policy: sitePolicy });
  await expect(provision(fake, 'reviewer', input())).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await expect(
    provision(fake, 'reviewer', {
      ...input('invalid-policy'),
      policy: { version: 'bad' },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await listed()).toBe(0);
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toEqual([]);
});

it('rejects public imports and missing reviewer ownership without remote reads', async () => {
  await reviewer();
  const { fake, get } = await artifacts();
  await expect(
    provision(fake, 'reviewer', {
      ...input(),
      source: 'https://example.com/project',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    provision(fake, 'reviewer', {
      ...input(),
      template: 'https://example.com/project',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await workspace(bindings, 'reviewer', { op: 'reviewer_revoke' });
  await expect(provision(fake, 'reviewer', input())).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(get).not.toHaveBeenCalled();
});

it('does not expose opaque starter SDK errors containing capabilities', async () => {
  await reviewer();
  const { fake, get } = await artifacts();
  get.mockRejectedValue(new Error('local-fixture-capability'));
  const failure = await provision(fake, 'reviewer', input()).catch(
    (error) => error,
  );
  expect(failure).toMatchObject({ code: 'SETUP_FAILED' });
  expect(failure.message).not.toContain('local-fixture-capability');
});

it('initializes frozen study and typed owner assertions without a run or model job', async () => {
  await reviewer();
  const { fake } = await artifacts();
  const body = {
    ...input('study-seed'),
    context_study: {
      id: 'booking-graph',
      case: 'event_booking_maintenance',
      arm: 'graph',
      corpus: ['context:booking-capacity'],
    },
    context_seed: {
      intent_id: 'intent:booking-study',
      statement: 'Preserve booking capacity',
      records: [
        {
          id: 'context:booking-capacity',
          kind: 'constraint',
          statement: 'Capacity never exceeded',
          purpose: 'Booking integrity',
          links: [],
          file_paths: [],
        },
      ],
    },
  };
  await provision(fake, 'reviewer', body);
  const snapshot = await ledger(bindings, body.repo_id, { op: 'snapshot', _workspace: 'reviewer' });
  expect(snapshot.repository.context_study).toMatchObject(body.context_study);
  expect(snapshot.nodes).toContainEqual(
    expect.objectContaining({
      id: 'context:booking-capacity',
      author: 'owner',
      data: expect.objectContaining({ authority: 'assertion', intent_id: 'intent:booking-study' }),
    }),
  );
  expect(snapshot.runs).toEqual([]);
  await expect(
    provision(fake, 'reviewer', {
      ...body,
      context_study: { ...body.context_study, arm: 'plain_notes' },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await ledger(bindings, body.repo_id, {
    op: 'configure_context_study',
    _workspace: 'reviewer',
    context_study: { ...body.context_study, arm: 'plain_notes' },
  });
  await expect(provision(fake, 'reviewer', body)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

it('pins starter HEAD across provisioning and seeds the frozen commit when the template moves', async () => {
  await reviewer();
  const { fake, get, commit, tree } = await artifacts();
  let reads = 0;
  const original = get.getMockImplementation()!;
  get.mockImplementation(async (name: string) => {
    const repo = await original(name);
    return { ...repo, log: async () => [{ hash: ++reads === 1 ? commit : 'd'.repeat(40) }] };
  });
  expect(await provision(fake, 'reviewer', input())).toMatchObject({ status: 'ready', commit });
  const platform = await projectPlatform(bindings, 'reviewer', 'fresh-campaign');
  const head = (await platform.call('GET', '/refs')).refs['refs/heads/main'];
  expect((await platform.call('GET', `/commits/${head}`)).tree).toBe(tree);
  expect(await provision(fake, 'reviewer', input())).toMatchObject({ status: 'ready', commit });
});

it('leaves only an unbound pending project when seeding fails and recovers on the same request', async () => {
  await reviewer();
  const { fake } = await artifacts();
  let failing = true;
  const local = interceptPlatform(fake, (path, request) =>
    failing && path === '/repos' && request.method === 'POST'
      ? platformJson({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic outage' } }, 503)
      : undefined,
  );
  await expect(provision(local, 'reviewer', input())).rejects.toMatchObject({ code: 'SETUP_FAILED' });
  // The reservation precedes the seed (bindings attach to it), but it is neither ready nor bound.
  const pending = await workspace(bindings, 'reviewer', { op: 'project_get', id: 'fresh-campaign' });
  expect(pending).toMatchObject({ status: 'provisioning' });
  expect(pending.platform).toBeUndefined();
  await expect(ledger(bindings, 'fresh-campaign', { op: 'repository_status' })).rejects.toThrow();
  failing = false;
  expect((await provision(local, 'reviewer', input())).status).toBe('ready');
  expect(await listed()).toBe(1);
});
