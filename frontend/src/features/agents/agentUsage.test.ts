import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedRun } from '../../../../shared/managed-agents';
import type { Loaded } from '../source-platform/useSource';

const answers = vi.hoisted(() => ({ byPath: new Map<string, Partial<Loaded<unknown>>>() }));
vi.mock('../source-platform/useSource', () => ({
  useSource: (path: string) => ({
    loading: false,
    reload: () => {},
    ...(answers.byPath.get(path) ?? { loading: true }),
  }),
}));
const { AgentRuns, AgentRunDetail } = await import('./AgentRuns');
const { AgentUsage } = await import('./AgentUsage');
const { recordedUsage, usageCount, usageOutcomes, usageTime } = await import('./agentUsageModel');

const run = (over: Partial<ManagedRun> = {}): ManagedRun => ({
  id: 'run-a',
  repo: 'r00000000000000000001',
  agent: 'code-review',
  change: 1,
  head: 'a'.repeat(40),
  status: 'passed',
  value: 'pass',
  summary: null,
  harness: 'codex',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  fallback: null,
  calls: 2,
  input_tokens: 1000,
  output_tokens: 200,
  container_seconds: 90,
  cost_usd: 0.03,
  findings: 0,
  withheld: 0,
  error: null,
  created_at: 1000,
  finished_at: 91000,
  ...over,
});
const page = () =>
  renderToStaticMarkup(
    createElement(AgentRuns, {
      workspace: 'ada',
      space: {},
      navigate: () => {},
    }),
  );
beforeEach(() => answers.byPath.clear());

it('summarizes the actual bounded run records with reported token coverage', () => {
  answers.byPath.set('/workspaces/ada/runs?limit=100', {
    data: {
      runs: [
        run(),
        run({
          id: 'run-b',
          status: 'failed',
          value: null,
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          container_seconds: 30,
          cost_usd: 0.01,
        }),
      ],
    },
  });
  const html = page();
  expect(html).toContain('Usage');
  expect(html).toContain('Latest 2 runs');
  expect(html).toContain('1,200');
  expect(html).toContain('1,000 in · 200 out');
  expect(html).toContain('Tokens not reported for 1 run');
  expect(html).toContain('2m');
  expect(html).toContain('$0.04');
  expect(html).toContain('1 passed');
  expect(html).toContain('1 failed');
});

it('does not invent tokens, model calls or execution time for unreported history', () => {
  const html = renderToStaticMarkup(
    createElement(AgentUsage, {
      runs: [
        run({
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          container_seconds: 0,
          status: 'queued',
          finished_at: null,
          cost_usd: 0,
        }),
      ],
    }),
  );
  expect(html.match(/>—</g)).toHaveLength(3);
  expect(html).toContain('Not reported');
  expect(html).toContain('1 unfinished');
  expect(html).toContain('$0.00');
  expect(html).not.toContain('0 in · 0 out');
  expect(html).not.toContain('messages');
});

it('uses recorded execution rather than queue time, and current cumulative retry usage once', () => {
  const r = run({ container_seconds: 3660, created_at: 0, finished_at: 86400000 });
  expect(recordedUsage([r])).toMatchObject({
    calls: 2,
    input: 1000,
    output: 200,
    seconds: 3660,
    cost: 0.03,
  });
  expect(usageTime(3660)).toBe('1h 1m');
  expect(usageTime(60)).toBe('1m');
  expect(usageTime(90)).toBe('1m 30s');
  expect(usageCount(12_345_678)).toBe('12.3M');
  expect(
    usageOutcomes({ passed: 2, findings: 1, queued: 1, paused: 2, cancelled: 1, superseded: 1 }),
  ).toBe('2 passed · 1 found issues · 3 unfinished · 2 stopped');
});

it('keeps an empty history empty and suppresses stale usage on denied or failed reads', () => {
  answers.byPath.set('/workspaces/ada/runs?limit=100', { data: { runs: [] } });
  expect(page()).toContain('No runs yet');
  expect(page()).not.toContain('Agent usage');
  for (const failure of [
    { error: 'Denied', code: 'FORBIDDEN', errorStatus: 403 },
    { error: 'Could not read runs', errorStatus: 503 },
  ]) {
    answers.byPath.set('/workspaces/ada/runs?limit=100', { data: { runs: [run()] }, ...failure });
    expect(page()).not.toContain('Agent usage');
  }
  expect(page()).toContain('Retry');
  answers.byPath.clear();
  expect(page()).toContain('Loading runs');
  expect(page()).toContain('Loading usage');
  expect(page()).toContain('aria-busy="true"');
  expect(page()).not.toContain('Latest 0 runs');
  expect(page()).not.toContain('1,200');
});

it('uses the existing agent-filtered run read and reports only those returned rows', () => {
  answers.byPath.set('/workspaces/ada/runs?agent=security-review&limit=100', {
    data: { runs: [run({ agent: 'security-review', input_tokens: 5000 })] },
  });
  const html = renderToStaticMarkup(
    createElement(AgentRuns, {
      workspace: 'ada',
      agent: 'security-review',
      space: {},
      navigate: () => {},
    }),
  );
  expect(html).toContain('Latest 1 run');
  expect(html).toContain('5,200');
  expect(html).toContain('aria-current="page" href="/agents/runs?agent=security-review"');
});

it('ignores malformed missing usage fields instead of printing NaN or inferred totals', () => {
  const totals = recordedUsage([
    run({ input_tokens: Number.NaN, container_seconds: Number.NaN, cost_usd: Number.NaN }),
  ]);
  expect(totals).toMatchObject({ reported: 0, timed: 0, priced: 0, calls: 0, input: 0, output: 0 });
});

it('shows earlier failed attempts while keeping current cumulative usage separate', () => {
  const r = run();
  answers.byPath.set(`/workspaces/ada/runs/${r.repo}/${r.id}`, {
    data: {
      run: r,
      findings: [],
      transcript: null,
      cost: [],
      previous_attempts: [
        {
          attempt: 1,
          run: run({
            input_tokens: 999999,
            cost_usd: 0.01,
            status: 'failed',
            value: null,
            model: 'previous-model',
            error: 'The harness container stopped before it reported',
            finished_at: 61000,
          }),
          findings: [],
        },
      ],
    },
  });
  const html = renderToStaticMarkup(
    createElement(AgentRunDetail, {
      workspace: 'ada',
      repo: r.repo,
      run: r.id,
      space: {},
      navigate: () => {},
    }),
  );
  expect(html).toContain('This run');
  expect(html).toContain('1,200');
  expect(html).toContain('$0.03');
  const currentUsage = html.match(
    /<section[^>]*aria-label="Agent usage"[^>]*>([\s\S]*?)<\/section>/,
  )?.[1];
  expect(currentUsage).toBeDefined();
  expect(currentUsage).toContain('$0.03');
  expect(currentUsage).not.toContain('$0.04');
  expect(html).toContain('Earlier attempts');
  expect(html).toContain('Attempt 1');
  expect(html).toContain('Failed');
  expect(html).toContain('previous-model');
  expect(html).toContain('The harness container stopped before it reported');
  expect(html).toContain('Finished');
  expect(html).toContain(new Date(61000).toLocaleString());
  expect(html).toContain('Cost so far');
  expect(html).toContain('$0.01');
  expect(html).toContain('Costs include earlier attempts.');
  expect(html).not.toContain('999,999');
  expect(html).not.toContain('Nothing was charged for this run.');
  expect(html).toContain('Cost breakdown is unavailable.');
  const noHistory = () =>
    renderToStaticMarkup(
      createElement(AgentRunDetail, {
        workspace: 'ada',
        repo: r.repo,
        run: r.id,
        space: {},
        navigate: () => {},
      }),
    );
  for (const history of [undefined, []]) {
    answers.byPath.set(`/workspaces/ada/runs/${r.repo}/${r.id}`, {
      data: {
        run: run({ cost_usd: 0 }),
        findings: [],
        transcript: null,
        cost: [],
        previous_attempts: history,
      },
    });
    expect(noHistory()).toContain('Nothing was charged for this run.');
    expect(noHistory()).not.toContain('Earlier attempts');
  }
});
