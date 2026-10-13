import { evictDurableObject, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { provisionCampaignProject } from '../../cloudflare/worker/campaign-provision';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
const admin = { role: 'admin' as const, workspace: '_admin' };
const template = 'yoneda-booking-campaign-starter-20261012';
const commit = 'a'.repeat(40);
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
function artifacts() {
  const repos = new Map<string, Json>();
  const missing = () => Object.assign(new Error('Missing'), { code: 'NOT_FOUND' });
  function remote(name: string, source: string | null = null, head = commit): Json {
    return {
      [Symbol.dispose]() {},
      info: async () => ({ name, defaultBranch: 'main', source, readOnly: false }),
      log: async () => (head ? [{ hash: head }] : []),
      listTokens: async () => ({ tokens: [{ id: 'initial', state: 'active' }] }),
      revokeToken: vi.fn(async () => true),
      fork: vi.fn(async (target: string, options: Json) => {
        if (repos.has(target)) throw Object.assign(new Error('Exists'), { code: 'ALREADY_EXISTS' });
        expect(options).toMatchObject({ defaultBranchOnly: true, readOnly: false });
        repos.set(target, remote(target, `artifacts:yoneda-test/${name}`, head));
        return { name: target, token: 'local-fixture-capability' };
      }),
    };
  }
  const starter = remote(template);
  repos.set(template, starter);
  const get = vi.fn(async (name: string) => {
    const repo = repos.get(name);
    if (!repo) throw missing();
    return repo;
  });
  const fake = { ...bindings, ARTIFACTS: { get } } as unknown as Env;
  return { fake, repos, get, starter, remote };
}
const input = (repo_id = 'fresh-campaign') => ({ repo_id, template, policy: sitePolicy });

it('forks exact private starter names and durably lists seven fresh reviewer projects without starting runs', async () => {
  await reviewer();
  const { fake, starter, repos } = artifacts();
  for (let n = 0; n < 7; n++) {
    const repo = n ? `fresh-study-${n}` : 'fresh-campaign';
    expect(await provisionCampaignProject(fake, admin, 'reviewer', input(repo))).toMatchObject({
      username: 'reviewer',
      repo_id: repo,
      status: 'ready',
      commit,
    });
    const snapshot = await ledger(bindings, repo, { op: 'snapshot', _workspace: 'reviewer' });
    expect(snapshot.repository).toMatchObject({
      workspace: 'reviewer',
      head_commit: commit,
      remote: { namespace: 'yoneda-test', name: repo, branch: 'main' },
    });
    expect(snapshot.runs).toEqual([]);
    expect(repos.get(repo)?.revokeToken).toHaveBeenCalledWith('initial');
  }
  expect(starter.fork).toHaveBeenCalledTimes(7);
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toHaveLength(7);
  expect((await workspace(bindings, 'reviewer', { op: 'reviewer_status' })).repo_id).toBe(
    'old-reviewer',
  );
});

it('rejects a nonadministrator before all Artifacts reads and state writes', async () => {
  const { fake, get } = artifacts();
  await expect(
    provisionCampaignProject(fake, { role: 'user', workspace: 'reviewer' }, 'reviewer', input()),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(get).not.toHaveBeenCalled();
});

it('replays the same reservation but rejects policy, template and workspace substitution', async () => {
  await reviewer();
  await reviewer('other');
  const { fake, starter } = artifacts();
  const result = await provisionCampaignProject(fake, admin, 'reviewer', input());
  expect(await provisionCampaignProject(fake, admin, 'reviewer', input())).toEqual(result);
  expect(starter.fork).toHaveBeenCalledOnce();
  for (const [owner, body] of [
    ['reviewer', { ...input(), policy: { ...sitePolicy, version: 'changed' } }],
    ['reviewer', { ...input(), template: 'another-starter' }],
    ['other', input()],
  ] as const) {
    await expect(provisionCampaignProject(fake, admin, owner, body)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  expect(starter.fork).toHaveBeenCalledOnce();
});

it('recovers a lost fork acknowledgment and survives authority eviction', async () => {
  await reviewer();
  const { fake, starter } = artifacts();
  const create = starter.fork;
  starter.fork = vi.fn(async (...args: unknown[]) => {
    await create(...args);
    throw new Error('Lost acknowledgment with fixture capability');
  });
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe('ready');
  await evictDurableObject(bindings.REPOSITORIES.getByName('fresh-campaign'));
  await evictDurableObject(bindings.WORKSPACES.getByName('account:reviewer'));
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe('ready');
  expect(starter.fork).toHaveBeenCalledOnce();
});

it('fences concurrent provisioning to one target and one workspace project', async () => {
  await reviewer();
  const { fake, repos } = artifacts();
  const results = await Promise.all([
    provisionCampaignProject(fake, admin, 'reviewer', input()),
    provisionCampaignProject(fake, admin, 'reviewer', input()),
  ]);
  expect(results.map((r) => r.commit)).toEqual([commit, commit]);
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe('ready');
  expect(repos.size).toBe(2);
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toHaveLength(1);
});

it('rejects foreign existing targets and invalid policies before any fork', async () => {
  await reviewer();
  const { fake, repos, starter, remote } = artifacts();
  repos.set('fresh-campaign', remote('fresh-campaign'));
  await expect(provisionCampaignProject(fake, admin, 'reviewer', input())).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await expect(
    provisionCampaignProject(fake, admin, 'reviewer', {
      ...input('invalid-policy'),
      policy: { version: 'bad' },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(starter.fork).not.toHaveBeenCalled();
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toEqual([]);
});

it('rejects public imports and missing reviewer ownership without remote reads', async () => {
  await reviewer();
  const { fake, get } = artifacts();
  await expect(
    provisionCampaignProject(fake, admin, 'reviewer', {
      ...input(),
      source: 'https://example.com/project',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    provisionCampaignProject(fake, admin, 'reviewer', {
      ...input(),
      template: 'https://example.com/project',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await workspace(bindings, 'reviewer', { op: 'reviewer_revoke' });
  await expect(provisionCampaignProject(fake, admin, 'reviewer', input())).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(get).not.toHaveBeenCalled();
});

it('does not expose opaque starter SDK errors containing capabilities', async () => {
  await reviewer();
  const { fake } = artifacts();
  const get = fake.ARTIFACTS.get.bind(fake.ARTIFACTS);
  fake.ARTIFACTS.get = async (name: string) => {
    if (name === template) throw new Error('local-fixture-capability');
    return get(name);
  };
  const failure = await provisionCampaignProject(fake, admin, 'reviewer', input()).catch(
    (error) => error,
  );
  expect(failure).toMatchObject({ code: 'SETUP_FAILED' });
  expect(failure.message).not.toContain('local-fixture-capability');
});

it('initializes frozen study and typed owner assertions without a run or model job', async () => {
  await reviewer();
  const { fake } = artifacts();
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
  await provisionCampaignProject(fake, admin, 'reviewer', body);
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
    provisionCampaignProject(fake, admin, 'reviewer', {
      ...body,
      context_study: { ...body.context_study, arm: 'plain_notes' },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await ledger(bindings, body.repo_id, {
    op: 'configure_context_study',
    _workspace: 'reviewer',
    context_study: { ...body.context_study, arm: 'plain_notes' },
  });
  await expect(provisionCampaignProject(fake, admin, 'reviewer', body)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

it('pins starter HEAD across provisioning and refuses a template moving during fork preparation', async () => {
  await reviewer();
  const { fake, starter } = artifacts();
  let reads = 0;
  starter.log = async () => [{ hash: ++reads === 1 ? commit : 'd'.repeat(40) }];
  await expect(provisionCampaignProject(fake, admin, 'reviewer', input())).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(starter.fork).not.toHaveBeenCalled();
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toEqual([]);
  starter.log = async () => [{ hash: commit }];
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe('ready');
});

it('reports a pending fork without publishing a workspace project and recovers on the same request', async () => {
  await reviewer();
  const { fake, starter } = artifacts();
  const create = starter.fork;
  starter.fork = vi.fn(async () => {
    throw Object.assign(new Error('Pending'), { code: 'FORK_IN_PROGRESS' });
  });
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe(
    'provisioning',
  );
  expect((await workspace(bindings, 'reviewer', { op: 'projects' })).projects).toEqual([]);
  starter.fork = create;
  expect((await provisionCampaignProject(fake, admin, 'reviewer', input())).status).toBe('ready');
});
