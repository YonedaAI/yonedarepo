// A landing policy that requires an agent's check: the agent posts it with its repository token.
// That token holds a scope per agent check (the platform refuses a required check to a plain
// `check` token), so it works whatever name a reconnect gave the token, and a token minted
// before those scopes is replaced the next time an owner saves the agent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { fakeGateway, type Harness, HEAD_A, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const save = (h: Harness, body: unknown) =>
  managedFetch(
    new Request(
      `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/code-review`,
      {
        method: 'PUT',
        headers: { cookie: 'session=owner', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    h.env,
  );

async function connected() {
  const h = harness(newRepo());
  h.platform.change({ files: FIXTURES['code-review'].trigger.files });
  h.platform.required = ['code-review'];
  expect((await save(h, { repos: [h.platform.repo] })).status).toBe(200);
  return h;
}

/** A review of the open change at `head`, reporting nothing. */
async function review(h: Harness, head = HEAD_A) {
  fakeGateway();
  h.harness.scripts = [{ result: { summary: 'Reviewed.', findings: [] } }];
  h.created.length = 0;
  const opened: QueueMessage = {
    kind: 'event',
    repo: h.platform.repo,
    event: 'change',
    ref: 'refs/heads/feature',
    commit: head,
    change: 1,
    action: 'opened',
  };
  await consume(
    { messages: [{ body: opened, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>,
    h.env,
  );
  return runAgent(h.env, h.created[0], inline);
}

describe('a required agent check', () => {
  it('is posted by the agent, and the run passes', async () => {
    const h = await connected();
    expect(await review(h)).toMatchObject({ status: 'passed', value: 'pass' });
    expect(h.platform.checks).toEqual([
      expect.objectContaining({ commit: HEAD_A, name: 'code-review', status: 'pass' }),
    ]);
  });

  it('still posts after a reconnect renames the token', async () => {
    const h = await connected();
    expect((await save(h, { repos: [] })).status).toBe(200);
    expect((await save(h, { repos: [h.platform.repo] })).status).toBe(200);
    const name = (await repoStub(h.env, h.platform.repo).connection())?.token_name;
    expect(name).toMatch(/^yoneda-managed-agents-[a-z0-9]+$/);
    expect(await review(h)).toMatchObject({ status: 'passed' });
    expect(h.platform.checks).toHaveLength(1);
  });

  describe('a run that ends with no reading', () => {
    async function failing(script: Record<string, unknown>) {
      const h = await connected();
      fakeGateway();
      h.harness.scripts = [script];
      const message: QueueMessage = { kind: 'event', repo: h.platform.repo, event: 'change', ref: 'refs/heads/feature', commit: HEAD_A, change: 1, action: 'opened' };
      await consume({ messages: [{ body: message, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>, h.env);
      return { h, outcome: await runAgent(h.env, h.created[0], inline) };
    }

    it('fails a required check and says so: nothing else would ever answer it', async () => {
      const { h, outcome } = await failing({ error: 'codex exited with 1' });
      expect(outcome.status).toBe('failed');
      expect(h.platform.checks).toHaveLength(1);
      expect(h.platform.checks[0]).toMatchObject({
        name: 'code-review',
        status: 'fail',
        commit: HEAD_A,
        evidence: expect.objectContaining({ value: null, no_reading: true }),
      });
      expect(h.platform.comments).toHaveLength(1);
      expect(h.platform.comments[0].body).toContain('could not finish');
      expect(h.platform.comments[0].body).toContain('Push again');
      expect(h.platform.comments[0].body).not.toContain('codex exited');
    });

    it('says nothing on a check no landing waits for: an outage is no go-around', async () => {
      const h = await connected();
      h.platform.required = [];
      fakeGateway();
      h.harness.scripts = [{ error: 'codex exited with 1' }];
      const message: QueueMessage = { kind: 'event', repo: h.platform.repo, event: 'change', ref: 'refs/heads/feature', commit: HEAD_A, change: 1, action: 'opened' };
      await consume({ messages: [{ body: message, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>, h.env);
      await runAgent(h.env, h.created[0], inline);
      expect(h.platform.checks).toEqual([]);
      expect(h.platform.comments).toEqual([]);
    });
  });

  it('a token from before the check scopes fails the run until an owner saves the agent', async () => {
    const h = await connected();
    const stub = repoStub(h.env, h.platform.repo);
    const before = await stub.connection();
    const old = String(before?.token_name);
    h.platform.scopes.set(old, ['read', 'review', 'check']);
    expect(await review(h)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('disable and enable'),
    });
    expect(h.platform.checks).toEqual([]);

    expect((await save(h, { repos: [h.platform.repo] })).status).toBe(200);
    const after = await stub.connection();
    expect(after?.token_name).toMatch(/^yoneda-managed-agents-[a-z0-9]+$/);
    expect(after?.token).not.toBe(before?.token);
    expect(after?.hook_id).toBe(before?.hook_id);
    expect(h.platform.revoked).toEqual([`tokens:${old}`]);
    expect(h.platform.hooks).toHaveLength(1);

    h.platform.change({ head: 'b'.repeat(40), files: FIXTURES['code-review'].trigger.files });
    expect(await review(h, 'b'.repeat(40))).toMatchObject({ status: 'passed' });
    expect(h.platform.checks).toHaveLength(1);

    // Already current: saving again mints nothing.
    const minted = h.platform.tokens.length;
    expect((await save(h, { repos: [h.platform.repo] })).status).toBe(200);
    expect(h.platform.tokens).toHaveLength(minted);
  });
});
