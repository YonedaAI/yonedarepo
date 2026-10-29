// The workspace Agents pages and Settings → Billing rendered from managed answers (useSource
// mocked per path): the overview cards, the settings form pre-filled for a first enable, the
// runs table, and the loading, not-an-owner and unavailable states.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentState,
  type BillingState,
  MANAGED_AGENTS,
  type ManagedRun,
  type WorkspaceState,
} from '../../../../shared/managed-agents';
import type { Loaded } from '../source-platform/useSource';

const answers = vi.hoisted(() => ({ byPath: new Map<string, Partial<Loaded<unknown>>>() }));
vi.mock('../source-platform/useSource', () => ({
  useSource: (path: string | null) => ({
    loading: false,
    reload: () => {},
    ...(answers.byPath.get(path ?? '') ?? { loading: true }),
  }),
}));

const { AgentsPage } = await import('./AgentsPage');
const { AgentSettingsPage } = await import('./AgentSettingsPage');
const { AgentRuns } = await import('./AgentRuns');
const { BillingSettings } = await import('../account-settings/BillingSettings');

const repoA = 'r0000000000000000000a';
const navigate = () => {};
const render = (component: unknown, props: object) =>
  renderToStaticMarkup(createElement(component as never, props));

const agentState = (i: number, over: Partial<AgentState> = {}): AgentState => {
  const def = MANAGED_AGENTS[i];
  return {
    ...def,
    settings: { ...def.defaults },
    customized: [],
    repo_overrides: {},
    enabled_repos: [],
    history: [],
    runs: 0,
    ...over,
  };
};
const workspace: WorkspaceState = {
  workspace: 'ada',
  agents: [
    agentState(0, {
      enabled_repos: [repoA],
      runs: 3,
      history: [
        { id: 'r1', repo: repoA, change: 2, value: 'fail', status: 'findings', created_at: 1 },
      ],
    }),
    agentState(1),
    agentState(2),
  ],
  credit: { granted_usd: 5, used_usd: 0.4, balance_usd: 4.6, paused: false },
  billing: 'coming',
  repos: [
    { id: repoA, name: 'parser' },
    { id: 'r0000000000000000000b', name: 'web-app' },
  ],
  token_name: 'yoneda-managed-agents',
};

beforeEach(() => answers.byPath.clear());

describe('the Agents overview', () => {
  it('shows the promo card and one card per managed agent, enabled ones with result and runs', () => {
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const html = render(AgentsPage, { workspace: 'ada', account: 'ada', orgs: [], navigate });
    expect(html).toContain('All agents');
    expect(html).toContain('Managed by YonedaRepo');
    expect(html).toContain('This one is on us!');
    expect(html).toContain('$0.40 used');
    for (const agent of MANAGED_AGENTS) {
      expect(html).toContain(agent.defaults.name);
      expect(html).toContain(agent.pitch);
    }
    expect(html).toContain('Enabled');
    expect(html).toContain('3 runs');
    expect(html).toMatch(/Fail on change #2/);
    expect(html.match(/>Enable</g)).toHaveLength(2);
    expect(html).toContain('href="/agents/security-review"');
    expect(html).toContain('href="/agents/runs"');
    expect(html).toContain('href="/agents/new"');
  });

  it('says when it is loading, when the caller is not an owner and when the service is absent', () => {
    expect(render(AgentsPage, { workspace: 'ada', account: 'ada', orgs: [], navigate })).toContain(
      'Loading',
    );
    answers.byPath.set('/workspaces/acme', { error: 'no', code: 'FORBIDDEN', errorStatus: 403 });
    expect(render(AgentsPage, { workspace: 'acme', account: 'ada', orgs: [], navigate })).toContain(
      'Only a workspace owner',
    );
    answers.byPath.set('/workspaces/ada', { error: 'gone', code: 'NOT_FOUND', errorStatus: 404 });
    expect(render(AgentsPage, { workspace: 'ada', account: 'ada', orgs: [], navigate })).toContain(
      'Managed agents are not available here',
    );
  });
});

describe('the agent settings page', () => {
  it('pre-fills the maintained defaults with every repository selected, ready to enable', () => {
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const html = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'slop-review',
      account: 'ada',
      navigate,
    });
    expect(html).toContain('maintained by YonedaRepo');
    expect(html).toContain('Low, medium or high');
    expect(html).toContain('Lower is better');
    expect(html).toContain('Block landing at');
    expect(html).toContain('On every push');
    expect(html).toContain('Ready for review');
    expect(html).toContain('+ Add filters');
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    expect(html).toContain('Enable agent');
    expect(html).toContain('<option value="mimo/mimo-v2.6-flash" selected="">');
  });

  it('shows history and Save once enabled, and the billing notice for a new agent', () => {
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const enabled = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'code-review',
      account: 'ada',
      navigate,
    });
    expect(enabled).toContain('Last results');
    expect(enabled).toContain('>Save<');
    expect(enabled).toContain('Pass or fail');
    expect(enabled).not.toContain('Block landing at');
    const fresh = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'new',
      account: 'ada',
      navigate,
    });
    expect(fresh).toContain('needs billing');
    expect(fresh).toMatch(/<button type="submit" disabled=""[^>]*>Create agent/);
    expect(
      render(AgentSettingsPage, { workspace: 'ada', agent: 'nope', account: 'ada', navigate }),
    ).toContain('There is no agent called');
  });
});

describe('runs and billing', () => {
  it('lists runs with result, model, fallback, cost and status', () => {
    const run: ManagedRun = {
      id: `${repoA}-cr-2-aaaaaaaaaaaa`,
      agent: 'code-review',
      repo: repoA,
      change: 2,
      head: 'a'.repeat(40),
      status: 'findings',
      value: 'fail',
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      fallback: 'glm-5.3-flash failed; used gpt-5.6-luna',
      calls: 3,
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0.0123,
      container_seconds: 60,
      findings: 1,
      withheld: 0,
      error: null,
      created_at: 1000,
      finished_at: 61_000,
    };
    answers.byPath.set('/workspaces/ada/runs?limit=100', { data: { runs: [run] } });
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const html = render(AgentRuns, { workspace: 'ada', space: {}, navigate });
    expect(html).toContain('parser');
    expect(html).toContain('#2');
    expect(html).toContain('Fail');
    expect(html).toContain('fallback');
    expect(html).toContain('$0.01<');
    expect(html).toContain('1 min');
    expect(html).toContain(`href="/agents/runs/${repoA}/${run.id}"`);
    answers.byPath.set('/workspaces/ada/runs?limit=100', { data: { runs: [] } });
    expect(render(AgentRuns, { workspace: 'ada', space: {}, navigate })).toContain('No runs yet');
  });

  it('shows the credit, no card on file, and usage by repository and agent', () => {
    const billing: BillingState = {
      workspace: 'ada',
      credit: { granted_usd: 5, used_usd: 0.3, balance_usd: 4.7, paused: false },
      payment_method: null,
      billing: 'coming',
      usage: [{ repo: repoA, repo_name: 'parser', agent: 'code-review', runs: 3, cost_usd: 0.3 }],
    };
    answers.byPath.set('/workspaces/ada/billing', { data: billing });
    const html = render(BillingSettings, { workspace: 'ada' });
    expect(html).toContain('Promotional credit is added on your first run: $5.00');
    expect(html).toContain('$4.70');
    expect(html).toContain('No card on file');
    expect(html).toContain('Set up billing');
    expect(html).toContain('<td>parser</td><td>Code review</td><td>3</td><td>$0.30</td>');
    answers.byPath.set('/workspaces/ada/billing', { data: { ...billing, usage: [] } });
    expect(render(BillingSettings, { workspace: 'ada' })).toContain('No agent has run yet');
  });
});
