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
  type ManagedCredit,
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
const { RepoManagedAgents } = await import('./RepoManagedAgents');
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
    created_by: null,
    created_at: null,
    active: true,
    all_repos: false,
    ...over,
  };
};
const credit = (over: Partial<ManagedCredit> = {}): ManagedCredit => ({
  granted_usd: 5,
  used_usd: 0.4,
  balance_usd: 4.6,
  paused: false,
  ...over,
});
const workspace: WorkspaceState = {
  workspace: 'ada',
  agents: [
    agentState(0, {
      enabled_repos: [repoA],
      created_by: 'ada',
      created_at: 1,
      runs: 3,
      history: [
        { id: 'r1', repo: repoA, change: 2, value: 'fail', status: 'findings', created_at: 1 },
      ],
    }),
    agentState(1),
    agentState(2),
  ],
  credit: credit(),
  billing: 'coming',
  repos: [
    { id: repoA, name: 'parser' },
    { id: 'r0000000000000000000b', name: 'web-app' },
  ],
  token_name: 'yoneda-managed-agents',
};

beforeEach(() => answers.byPath.clear());

describe('the Agents overview', () => {
  it('shows the credit card and one card per managed agent: Add agent, or Active with a menu', () => {
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
    expect(html).toContain('>Active<');
    expect(html).toContain('3 runs');
    expect(html).toMatch(/Fail on change #2/);
    expect(html).toMatch(
      /aria-label="Code review actions" aria-haspopup="menu" aria-expanded="false"/,
    );
    expect(html.match(/>Add agent</g)).toHaveLength(2);
    expect(html).toContain('href="/agents/security-review/configure"');
    expect(html).toContain('href="/agents/code-review"');
    expect(html).toContain('href="/agents/runs"');
    // New agent stays in view, closed until billing exists.
    expect(html).toMatch(/<button type="button" class="agents-new" disabled=""[^>]*>New agent/);
    expect(html).toContain('Set up billing to create your own agents');
    expect(html).toContain('of starting credit when you set up your first agent');
    expect(html).toMatch(/<button type="button" class="quiet" disabled=""[^>]*>Set up billing/);
    expect(html).toContain('1 repository');
    const paused = {
      ...workspace,
      agents: [{ ...workspace.agents[0], active: false }, ...workspace.agents.slice(1)],
    };
    answers.byPath.set('/workspaces/ada', { data: paused });
    expect(render(AgentsPage, { workspace: 'ada', account: 'ada', orgs: [], navigate })).toContain(
      '>Paused<',
    );
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

describe("an agent's pages", () => {
  it('sets up an agent not set up yet: what YonedaRepo maintains read-only, the rest editable', () => {
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const html = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'slop-review',
      account: 'ada',
      navigate,
    });
    expect(html).toContain('<h1>Set up Slop review</h1>');
    expect(html).toContain('YonedaRepo maintains this agent&#x27;s model and instructions.');
    expect(html).not.toContain('customize it to make it your own');
    expect(html).not.toContain('Reset to maintained defaults');
    for (const [label, value] of [
      ['Name', 'Slop review'],
      ['Harness', 'opencode'],
      ['Model', 'MiMo V2.6 Flash'],
      ['Reasoning effort', 'Low'],
      ['Time limit', '15 minutes'],
      ['Result format', 'Low, medium or high'],
    ])
      expect(html).toMatch(
        new RegExp(
          `${label}<input class="agent-fixed" readOnly="" aria-readonly="true" value="${value}"/>`,
        ),
      );
    // Nothing maintained is an editable control: only the trigger selects, filters, repos and Active.
    expect(html.match(/<input(?![^>]*readOnly)[^>]*type="(text|number)"/g)).toBeNull();
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).toContain(
      '<section class="agent-fixed agent-instructions" aria-labelledby="instructions-label"><pre tabindex="0">',
    );
    expect(html).toContain('Lower is better');
    expect(html).toContain('<code>slop-review: medium</code>');
    expect(html).not.toContain('Block landing at');
    expect(html).toContain('On every push');
    expect(html).toContain('Ready for review');
    expect(html).toContain('unless its title starts with Draft: or WIP:');
    expect(html).toContain('+ Add filters');
    expect(html).toContain('All repositories, including new ones');
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    expect(html).toMatch(/type="checkbox" role="switch" aria-checked="true" checked=""/);
    expect(html).toMatch(/<button type="submit">Add agent<\/button>/);
    expect(html).not.toContain('>Cancel<');
  });

  it('sets up with no repositories yet: all repositories chosen, ways to make one, Add agent open', () => {
    answers.byPath.set('/workspaces/ada', { data: { ...workspace, repos: [] } });
    const html = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'security-review',
      account: 'ada',
      navigate,
      onNewRepository: () => {},
    });
    expect(html).toContain('Set up Security review');
    expect(html).toMatch(/type="radio" name="repo-scope" checked=""\/>/);
    expect(html).toContain('No repositories yet.');
    expect(html).toContain('>Create a repository<');
    expect(html).toMatch(/href="\/docs\/guides\/import"[^>]*>Import from GitHub/);
    expect(html).not.toContain('agent-repo-list');
    expect(html).toMatch(/<button type="submit">Add agent<\/button>/);
  });

  it("shows a set-up agent's page: runs in UTC, what it is, when it runs, repositories, history and its menu", () => {
    const run: ManagedRun = {
      id: `${repoA}-cr-2-aaaaaaaaaaaa`,
      agent: 'code-review',
      repo: repoA,
      change: 2,
      head: 'a'.repeat(40),
      status: 'findings',
      value: 'fail',
      summary: null,
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      fallback: null,
      calls: 1,
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0.006,
      container_seconds: 30,
      findings: 2,
      withheld: 0,
      error: null,
      created_at: Date.UTC(2026, 9, 30, 12, 19, 50),
      finished_at: Date.UTC(2026, 9, 30, 12, 20, 40),
    };
    answers.byPath.set('/workspaces/ada', { data: workspace });
    answers.byPath.set('/workspaces/ada/runs?agent=code-review&limit=50', {
      data: { runs: [run] },
    });
    const html = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'code-review',
      account: 'ada',
      navigate,
    });
    expect(html).toContain('>Active<');
    expect(html).toContain('<th>Created (UTC)</th>');
    expect(html).toContain('2026-10-30 12:19 UTC');
    expect(html).toContain(`href="/agents/runs/${repoA}/${run.id}"`);
    expect(html).toContain('parser #2');
    expect(html).toContain('Codex · GPT-5.6 Luna');
    expect(html).toContain('On every push, changes ready for review');
    expect(html).toContain('Created by ada,');
    expect(html).toContain('href="/agents/code-review/configure"');
    expect(html).toContain('aria-label="Code review actions"');
    answers.byPath.set('/workspaces/ada/runs?agent=code-review&limit=50', { data: { runs: [] } });
    expect(
      render(AgentSettingsPage, {
        workspace: 'ada',
        agent: 'code-review',
        account: 'ada',
        navigate,
      }),
    ).toContain('No runs yet');
  });

  it('configures a set-up agent: no reset, Save changes and Cancel, all repositories when set', () => {
    const all = {
      ...workspace,
      agents: [
        { ...workspace.agents[0], all_repos: true, customized: ['trigger'] },
        ...workspace.agents.slice(1),
      ],
    };
    answers.byPath.set('/workspaces/ada', { data: all });
    const html = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'code-review',
      account: 'ada',
      configure: true,
      navigate,
    });
    expect(html).toContain('Configure Code review');
    expect(html).not.toContain('Reset to maintained defaults');
    expect(html).not.toContain('This workspace changed');
    expect(html).toContain('>Save changes<');
    expect(html).toContain('href="/agents/code-review">Cancel<');
    expect(html).toContain('Pass or fail');
    expect(html).toContain('<code>code-review: fail</code>');
    // All repositories: the choice is on and the checklist is disabled, every box shown ticked.
    expect(html).toMatch(/type="radio" name="repo-scope" checked=""\/>/);
    expect(html).toMatch(/<fieldset class="agent-panel-row agent-repo-choice" disabled="">/);
    expect(html).toContain('2 of 2 selected');
    answers.byPath.set('/workspaces/ada/runs?agent=code-review&limit=50', { data: { runs: [] } });
    const detail = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'code-review',
      account: 'ada',
      navigate,
    });
    expect(detail).toContain('<p>All repositories, including new ones</p>');
  });

  it('keeps a new agent closed until billing, saying so', () => {
    answers.byPath.set('/workspaces/ada', { data: workspace });
    const gated = render(AgentSettingsPage, {
      workspace: 'ada',
      agent: 'new',
      account: 'ada',
      navigate,
    });
    expect(gated).toContain('Set up billing to create your own agents');
    expect(gated).toMatch(/<button type="button" disabled=""[^>]*>Create agent/);
    expect(
      render(AgentSettingsPage, { workspace: 'ada', agent: 'nope', account: 'ada', navigate }),
    ).toContain('There is no agent called');
  });
});

describe("a repository's agents", () => {
  it('lists the agents on it with status, harness and latest review, or says there are none', () => {
    const path = `/workspaces/ada/repos/${repoA}/agents`;
    answers.byPath.set(path, {
      data: {
        agents: [
          {
            id: 'code-review',
            name: 'Code review',
            status: 'active',
            harness: 'codex',
            model: 'gpt-5.6-luna',
            latest: {
              id: 'x',
              repo: repoA,
              change: 4,
              value: 'pass',
              status: 'passed',
              created_at: Date.UTC(2026, 9, 30, 9),
            },
          },
          {
            id: 'slop-review',
            name: 'Slop review',
            status: 'paused',
            harness: 'opencode',
            model: 'mimo-v2.6-flash',
            latest: null,
          },
          {
            id: 'security-review',
            name: 'Security review',
            status: 'off',
            harness: 'claude-code',
            model: 'claude-sonnet-5-5',
            latest: null,
          },
        ],
      },
    });
    const html = render(RepoManagedAgents, {
      repo: repoA,
      workspace: 'ada',
      account: 'ada',
      navigate,
    });
    expect(html).toContain('<th>Name</th><th>Status</th><th>Harness</th><th>Latest review</th>');
    expect(html).toContain('>Active<');
    expect(html).toContain('>Paused<');
    expect(html).not.toContain('Security review');
    expect(html).toContain(`href="/source/${repoA}/changes/4"`);
    expect(html).toContain('No review yet');
    expect(html).toContain('Manage agents');
    answers.byPath.set(path, { data: { agents: [] } });
    expect(
      render(RepoManagedAgents, { repo: repoA, workspace: 'ada', account: 'ada', navigate }),
    ).toContain('No managed agent reviews this repository yet');
    answers.byPath.set(path, { error: 'no', code: 'FORBIDDEN', errorStatus: 403 });
    expect(
      render(RepoManagedAgents, { repo: repoA, workspace: 'ada', account: 'ada', navigate }),
    ).toContain('Only a workspace owner');
  });
});

describe('runs', () => {
  it('lists runs with result, model, fallback, cost and status', () => {
    const run: ManagedRun = {
      id: `${repoA}-cr-2-aaaaaaaaaaaa`,
      agent: 'code-review',
      repo: repoA,
      change: 2,
      head: 'a'.repeat(40),
      status: 'findings',
      value: 'fail',
      summary: 'Reads past the end of the list.',
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
    expect(html).toContain('Starting credit is added when you set up your first agent: $5.00');
    expect(html).toContain('$4.70');
    expect(html).toContain('No card on file');
    expect(html).toContain('Set up billing');
    expect(html).toContain('<td>parser</td><td>Code review</td><td>3</td><td>$0.30</td>');
    answers.byPath.set('/workspaces/ada/billing', { data: { ...billing, usage: [] } });
    expect(render(BillingSettings, { workspace: 'ada' })).toContain('No agent has run yet');
  });
});
