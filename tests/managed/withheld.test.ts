// Withheld findings fail closed: a finding the managed Worker cannot post (no line of the change
// to anchor to, text that looks like a credential, or a comment the platform's secret scanner
// refuses) still counts toward the run's value at its severity, and the summary comment lists
// it by severity and defused title (never the credential-looking text). A path the agent wrote
// as the checkout's absolute path still anchors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueMessage } from '../../cloudflare/managed/config';
import { consume } from '../../cloudflare/managed/dispatch';
import { managedFetch } from '../../cloudflare/managed/index';
import { runAgent } from '../../cloudflare/managed/run';
import type { ManagedAgentId } from '../../shared/managed-agents';
import { fakeGateway, type Harness, HEAD_A, harness, inline, newRepo } from './fake';
import { FIXTURES } from './fixtures';

afterEach(() => vi.restoreAllMocks());

async function review(
  agent: ManagedAgentId,
  findings: Record<string, unknown>[],
  setup?: (h: Harness) => void,
) {
  const h = harness(newRepo());
  h.platform.change({ files: FIXTURES[agent].trigger.files });
  setup?.(h);
  const put = await managedFetch(
    new Request(
      `https://site.example.com/api/managed/workspaces/${h.platform.account}/agents/${agent}`,
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
  h.harness.scripts = [{ result: { summary: 'Reviewed.', findings } }];
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
    {
      messages: [{ body: opened, ack: vi.fn(), retry: vi.fn() }],
    } as unknown as MessageBatch<QueueMessage>,
    h.env,
  );
  const outcome = await runAgent(h.env, h.created[0], inline);
  const summary = h.platform.comments.find((c) => !c.path)?.body ?? '';
  return { h, outcome, summary, check: h.platform.checks[0] };
}

const secret = ['ghp', `${'A1b2C3d4E5'.repeat(3)}abcdef`].join('_');

describe('withheld findings fail closed', () => {
  it('an unanchored high finding fails the check and is listed in the summary', async () => {
    const { outcome, summary, check, h } = await review('security-review', [
      {
        path: 'src/users.js',
        line: 99,
        severity: 'high',
        title: 'SQL injection through id',
        why: 'Concatenated.',
      },
    ]);
    expect(outcome).toMatchObject({ status: 'findings', value: 'fail', findings: 0, withheld: 1 });
    expect(check).toMatchObject({
      status: 'fail',
      evidence: expect.objectContaining({
        value: 'fail',
        withheld: { high: 1, medium: 0, low: 0 },
      }),
    });
    expect(h.platform.comments.filter((c) => c.path)).toHaveLength(0);
    expect(summary).toMatch(
      /Withheld \(not posted on a line\):\n- High: SQL injection through id \(no line of this change to anchor to\)/,
    );
  });

  it('a credential-looking finding fails the check without its text reaching any comment', async () => {
    const { outcome, summary, check, h } = await review('security-review', [
      {
        path: 'src/users.js',
        line: 2,
        severity: 'high',
        title: `Token ${secret} committed`,
        why: 'It is live.',
      },
    ]);
    expect(outcome).toMatchObject({ value: 'fail', findings: 0, withheld: 1 });
    expect(check.status).toBe('fail');
    expect(summary).toContain('- High: (title hidden: it looked like a credential)');
    expect(JSON.stringify([h.platform.comments, h.platform.checks])).not.toContain('ghp_');
  });

  it('a comment the platform scanner refuses still counts and is listed without its text', async () => {
    const { outcome, summary, check } = await review(
      'security-review',
      [
        {
          path: 'src/users.js',
          line: 2,
          severity: 'medium',
          title: 'Key in source',
          why: 'Value PLATFORM-ONLY-SECRET-1234.',
        },
      ],
      (h) => {
        h.platform.scannerRefuses = /PLATFORM-ONLY-SECRET/;
      },
    );
    expect(outcome).toMatchObject({ value: 'fail', findings: 0, withheld: 1 });
    expect(check.status).toBe('fail');
    expect(summary).toContain(
      '- Medium: (title hidden: the platform refused the comment as a credential)',
    );
    expect(summary).not.toContain('PLATFORM-ONLY-SECRET');
  });

  it('a level agent counts a withheld finding at its capped level', async () => {
    const { outcome, check, summary } = await review('slop-review', [
      {
        path: 'src/cart.ts',
        line: 500,
        severity: 'high',
        title: 'Debug logging left in',
        why: 'console.log',
      },
    ]);
    expect(outcome).toMatchObject({ value: 'medium', findings: 0, withheld: 1 });
    expect(check).toMatchObject({
      status: 'pass',
      evidence: expect.objectContaining({ value: 'medium' }),
    });
    expect(summary).toContain(
      '- Medium: Debug logging left in (no line of this change to anchor to)',
    );
  });

  it('a path written as the checkout path, ./ or a git a/ b/ prefix still anchors', async () => {
    const { outcome, h } = await review('security-review', [
      {
        path: '/work/repo/src/users.js',
        line: 2,
        severity: 'high',
        title: 'SQL injection',
        why: 'x',
      },
      { path: './src/users.js', line: 3, severity: 'medium', title: 'Raw query', why: 'y' },
      { path: 'b/src/users.js', line: 5, severity: 'low', title: 'Unused export', why: 'z' },
    ]);
    expect(outcome).toMatchObject({ value: 'fail', findings: 3, withheld: 0 });
    expect(h.platform.comments.filter((c) => c.path).map((c) => `${c.path}:${c.line}`)).toEqual([
      'src/users.js:2',
      'src/users.js:3',
      'src/users.js:5',
    ]);
  });
});
