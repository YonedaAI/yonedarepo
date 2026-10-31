// A change holds at most 2,000 comments and each run adds up to 21. Past the cap the platform
// refuses the post; the run must still finish: findings count at their severity, the check is
// posted, and nothing retries forever or fails the run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { repoStub } from '../../cloudflare/managed/repo-agents';
import { runAgent } from '../../cloudflare/managed/run';
import { fakeGateway, HEAD_A, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

async function review(room: number) {
  const h = harness(newRepo());
  h.platform.change({ files: FIXTURES['code-review'].trigger.files });
  h.platform.commentRoom = room;
  const put = await managedFetch(
    new Request(
      `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/code-review`,
      {
        method: 'PUT',
        headers: { cookie: 'session=owner', 'content-type': 'application/json' },
        body: JSON.stringify({ repos: [h.platform.repo] }),
      },
    ),
    h.env,
  );
  expect(put.status).toBe(200);
  fakeGateway();
  const [finding] = FIXTURES['code-review'].trigger.expected;
  h.harness.scripts = [
    {
      result: {
        summary: 'Reviewed.',
        findings: [finding, { ...finding, line: finding.line + 1, title: 'A second one' }],
      },
    },
  ];
  const opened: QueueMessage = {
    kind: 'event',
    repo: h.platform.repo,
    event: 'change',
    ref: 'refs/heads/feature',
    commit: HEAD_A,
    change: 1,
    action: 'opened',
  };
  await consume(
    { messages: [{ body: opened, ack: vi.fn(), retry: vi.fn() }] } as unknown as MessageBatch<QueueMessage>,
    h.env,
  );
  const outcome = await runAgent(h.env, h.created[0], inline);
  return { h, outcome, check: h.platform.checks[0] };
}

describe('a change at its comment cap', () => {
  it('still reports: the check fails on the findings it could not post', async () => {
    const { h, outcome, check } = await review(0);
    expect(outcome).toMatchObject({ status: 'findings', value: 'fail', findings: 0, withheld: 2 });
    expect(h.platform.comments).toEqual([]);
    expect(check).toMatchObject({
      status: 'fail',
      evidence: expect.objectContaining({ value: 'fail', withheld: { high: 2, medium: 0, low: 0 } }),
    });
    const run = await repoStub(h.env, h.platform.repo).run(h.created[0].run);
    expect(run).toMatchObject({ status: 'findings', withheld: 2, error: null });
  });

  it('stops asking once refused, and keeps what fitted', async () => {
    const { h, outcome } = await review(1);
    expect(outcome).toMatchObject({ status: 'findings', findings: 1, withheld: 1 });
    expect(h.platform.comments).toHaveLength(1);
    const refused = h.platform.requests.filter((r) => r.path.endsWith('/comments')).length;
    expect(refused).toBe(3); // the one posted, the one refused, then only the summary tried
  });

  it('with room for all but the summary, the run still finishes', async () => {
    const { h, outcome, check } = await review(2);
    expect(outcome).toMatchObject({ status: 'findings', findings: 2, withheld: 0 });
    expect(h.platform.comments).toHaveLength(2);
    expect(check.status).toBe('fail');
  });
});
