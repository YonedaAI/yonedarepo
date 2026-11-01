// Intent drift: a managed agent that compares a change's flight plan with its diff and gives
// one verdict on the whole change, not findings on lines. The value comes from a fixed list,
// and a reply without one fails the run instead of inventing a value. No plan means no model
// and no container: the check says so and costs nothing. Off until enabled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { managedAgent } from '../../shared/managed-agents';
import { VERDICT_CONTRACT } from '../../shared/managed-instructions';
import { fakeGateway, type Harness, HEAD_A, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

const PLAN = { goal: 'Look users up by id', scope: 'src/users.js only' };

async function enable(h: Harness) {
  const put = await managedFetch(
    new Request(
      `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/intent-drift`,
      {
        method: 'PUT',
        headers: { cookie: 'session=owner', 'content-type': 'application/json' },
        body: JSON.stringify({ repos: [h.platform.repo] }),
      },
    ),
    h.env,
  );
  expect(put.status).toBe(200);
}

const opened: QueueMessage = {
  kind: 'event',
  repo: '',
  event: 'change',
  ref: 'refs/heads/feature',
  commit: HEAD_A,
  change: 1,
  action: 'opened',
};

async function open(h: Harness) {
  const message = { ...opened, repo: h.platform.repo } as QueueMessage;
  await consume(
    {
      messages: [{ body: message, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as MessageBatch<QueueMessage>,
    h.env,
  );
}

async function run(result: Record<string, unknown> | null, over: object = { flight_plan: PLAN }) {
  const h = harness(newRepo());
  h.platform.change({
    files: FIXTURES['intent-drift'].trigger.files,
    body: 'Why this change exists.',
    ...over,
  });
  await enable(h);
  fakeGateway();
  h.harness.scripts = result ? [{ result }] : [];
  await open(h);
  const outcome = await runAgent(h.env, h.created[0], inline);
  return { h, outcome, check: h.platform.checks[0] };
}

const stored = (h: Harness, id: string) => repoStub(h.env, h.platform.repo).run(id);

describe('intent drift', () => {
  it('starts nothing until it is enabled', async () => {
    const h = harness(newRepo());
    h.platform.change({ flight_plan: PLAN });
    await open(h);
    expect(h.created).toEqual([]);
    expect(h.harness.started).toEqual([]);
  });

  it('is a level agent named intent-drift that fails its check at high by default', () => {
    expect(managedAgent('intent-drift')).toMatchObject({
      check: 'intent-drift',
      value_type: 'level',
      verdict: true,
      defaults: { block_at: 'high' },
    });
  });

  it('hands the harness the plan and the body, and only this agent', async () => {
    const { h } = await run({ summary: 'Matches.', verdict: 'on_course', findings: [] });
    const { spec } = h.harness.started[0];
    expect(spec.context.plan).toEqual(PLAN);
    expect(spec.context.body).toBe('Why this change exists.');
    expect(spec.contract).toBe(VERDICT_CONTRACT);

    const other = harness(newRepo());
    other.platform.change({ flight_plan: PLAN, body: 'Body.' });
    const put = await managedFetch(
      new Request(
        `https://site.example.com/api/managed/workspaces/${other.platform.account}/agents/code-review`,
        {
          method: 'PUT',
          headers: { cookie: 'session=owner', 'content-type': 'application/json' },
          body: JSON.stringify({ repos: [other.platform.repo] }),
        },
      ),
      other.env,
    );
    expect(put.status).toBe(200);
    fakeGateway();
    other.harness.scripts = [{ result: { summary: 'ok', findings: [] } }];
    await open(other);
    await runAgent(other.env, other.created[0], inline);
    expect(other.harness.started[0].spec.context.plan).toBeUndefined();
    expect(other.harness.started[0].spec.context.body).toBeUndefined();
  });

  it.each([
    ['on_course', 'low', 'passed', 'pass'],
    ['partial', 'medium', 'findings', 'pass'],
    ['off_course', 'high', 'findings', 'fail'],
  ])('%s reads as %s and posts one comment and a check', async (verdict, value, status, passed) => {
    const { h, outcome, check } = await run({
      summary: 'Compared the goal with the diff.',
      verdict,
      findings: [{ title: 'Adds a cache', why: 'The goal does not mention one.' }],
    });
    expect(outcome).toMatchObject({ status, value });
    expect(h.platform.comments).toHaveLength(1);
    const comment = h.platform.comments[0];
    expect(comment.path).toBeUndefined();
    expect(comment.body).toContain('Compared the goal with the diff.');
    expect(comment.body).toContain('Adds a cache');
    expect(check).toMatchObject({
      name: 'intent-drift',
      status: passed,
      commit: HEAD_A,
      evidence: expect.objectContaining({ agent: 'intent-drift', value, verdict }),
    });
    expect(await stored(h, h.created[0].run)).toMatchObject({ status, value });
  });

  it.each([
    ['medium', 'partial', 'fail'],
    ['medium', 'on_course', 'pass'],
    [null, 'off_course', 'pass'],
  ])('set to block at %s, %s is a %s', async (block_at, verdict, status) => {
    const h = harness(newRepo());
    h.platform.change({ flight_plan: PLAN });
    await enable(h);
    const set = await managedFetch(
      new Request(
        `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/intent-drift`,
        {
          method: 'PUT',
          headers: { cookie: 'session=owner', 'content-type': 'application/json' },
          body: JSON.stringify({ settings: { block_at } }),
        },
      ),
      h.env,
    );
    expect(set.status).toBe(200);
    fakeGateway();
    h.harness.scripts = [{ result: { summary: 's', verdict, findings: [] } }];
    await open(h);
    await runAgent(h.env, h.created[0], inline);
    expect(h.platform.checks[0]).toMatchObject({ status });
  });

  it('with no plan runs no model and no container, and the check says so', async () => {
    const { h, outcome, check } = await run(null, { flight_plan: null });
    expect(h.harness.started).toEqual([]);
    expect(outcome).toMatchObject({ status: 'stopped', reason: 'no_flight_plan' });
    expect(check).toMatchObject({
      name: 'intent-drift',
      status: 'pass',
      evidence: expect.objectContaining({ value: null, no_plan: true }),
    });
    expect(h.platform.comments).toEqual([]);
    expect(await stored(h, h.created[0].run)).toMatchObject({
      status: 'passed',
      value: null,
      summary: 'No flight plan',
      cost_usd: 0,
    });
  });

  it('a platform that does not answer flight_plan yet reads as no plan', async () => {
    const { h, check } = await run(null, {});
    expect(h.harness.started).toEqual([]);
    expect(check.evidence.no_plan).toBe(true);
  });

  it.each([[{}], [{ verdict: 'fine' }], [{ verdict: 7 }]])(
    'a reply without a verdict fails the run and posts nothing: %j',
    async (reply) => {
      const { h, outcome } = await run({ summary: 's', findings: [], ...reply });
      expect(outcome.status).toBe('failed');
      expect(h.platform.checks).toEqual([]);
      expect(h.platform.comments).toEqual([]);
    },
  );

  it('defuses what the model wrote and leaves out anything like a credential', async () => {
    const secret = ['ghp', `${'A1b2C3d4E5'.repeat(3)}abcdef`].join('_');
    const { h } = await run({
      summary: '<b>Bold</b> [click](https://evil.example.com)',
      verdict: 'partial',
      findings: [
        { title: 'Leak', why: `key ${secret}` },
        { title: 'x'.repeat(500), why: 'y'.repeat(5000) },
        ...Array.from({ length: 30 }, (_, i) => ({ title: `Reason ${i}`, why: 'w' })),
      ],
    });
    const body = h.platform.comments[0].body as string;
    expect(body).not.toContain(secret);
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('evil.example.com');
    expect(body.length).toBeLessThan(8000);
    expect(body).not.toContain('Reason 29');
  });

  it('a retried post leaves one comment', async () => {
    const { h } = await run({ summary: 's', verdict: 'on_course', findings: [] });
    const { postVerdict } = await import('../../cloudflare/managed/verdict');
    const connection = await repoStub(h.env, h.platform.repo).connection();
    await postVerdict(
      h.env,
      h.created[0],
      managedAgent('intent-drift') as any,
      connection?.token as string,
      { summary: 's', verdict: 'on_course', findings: [] },
      null,
    );
    expect(h.platform.comments).toHaveLength(1);
  });
});
