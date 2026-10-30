// The workspace Agents pages' model: routes, cards, tiles, the settings form and the body it
// saves, model options and prices, runs, billing and the pricing page's agent rows.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MARGIN,
  type AgentState,
  MANAGED_AGENTS,
  type ManagedAgentId,
  type WorkspaceState,
} from '../../../../shared/managed-agents';
import { agentUsageRows } from '../site/pricing';
import {
  formatSourceRoute,
  parseSourceRoute,
  type SourceRoute,
} from '../source-platform/sourceRoute';
import { HistoryStrip } from './agentParts';
import {
  cardState,
  costLabel,
  costUsd,
  creditPercent,
  customizedText,
  filterRepos,
  formatCost,
  formatDuration,
  formProblem,
  initialForm,
  modelOptions,
  newAgentForm,
  parseFilters,
  runsPath,
  tileTone,
  updateBody,
  usageTotals,
  usedText,
  visibleAgents,
  withHarness,
  workspaceOptions,
} from './agentsModel';

const repoA = 'r0000000000000000000a';
const repoB = 'r0000000000000000000b';
const repos = [
  { id: repoA, name: 'parser' },
  { id: repoB, name: 'web-app' },
];

function state(id: ManagedAgentId, over: Partial<AgentState> = {}): AgentState {
  const def = MANAGED_AGENTS.find((a) => a.id === id) as (typeof MANAGED_AGENTS)[number];
  return {
    ...def,
    settings: { ...def.defaults, trigger: { ...def.defaults.trigger } },
    customized: [],
    repo_overrides: {},
    enabled_repos: [],
    history: [],
    runs: 0,
    ...over,
  };
}

describe('routes', () => {
  it('address every Agents page, with an org workspace in the query', () => {
    for (const route of [
      { view: 'agents-home' },
      { view: 'agents-home', workspace: 'acme' },
      { view: 'agent-settings', agent: 'code-review' },
      { view: 'agent-settings', agent: 'new', workspace: 'acme' },
      { view: 'agent-runs' },
      { view: 'agent-runs', agent: 'slop-review' },
      { view: 'agent-run', runRepo: repoA, run: `${repoA}-cr-3-aaaaaaaaaaaa` },
      // An account named by email before email-only sign-up is a workspace too.
      { view: 'agents-home', workspace: 'dev.owner+agents@example.com' },
    ] as SourceRoute[]) {
      const [path, query = ''] = formatSourceRoute(route).split('?');
      expect(parseSourceRoute(path, query ? `?${query}` : '')).toEqual(route);
    }
    expect(formatSourceRoute({ view: 'agents-home' })).toBe('/agents');
    expect(formatSourceRoute({ view: 'agent-runs', agent: 'code-review', workspace: 'acme' })).toBe(
      '/agents/runs?agent=code-review&workspace=acme',
    );
    // Odd input falls back to the overview, never to a repository page.
    expect(parseSourceRoute('/agents/runs/not-a-repo/x', '')).toEqual({ view: 'agent-runs' });
    expect(parseSourceRoute('/agents/Bad Agent', '')).toEqual({ view: 'agents-home' });
    expect(parseSourceRoute('/agents', '?workspace=Not%20A%20Name')).toEqual({
      view: 'agents-home',
    });
  });

  it('builds the managed API paths', () => {
    expect(runsPath('dev.owner+agents@example.com', {}, 5)).toBe(
      '/workspaces/dev.owner%2Bagents%40example.com/runs?limit=5',
    );
    expect(runsPath('acme', { agent: 'code-review' }, 50)).toBe(
      '/workspaces/acme/runs?agent=code-review&limit=50',
    );
  });
});

describe('overview cards', () => {
  it('show off, or enabled with the newest result and the run count', () => {
    expect(cardState(state('code-review'))).toMatchObject({ enabled: false, last: null, runs: 0 });
    const tile = {
      id: 'x',
      repo: repoA,
      change: 4,
      value: 'fail' as const,
      status: 'findings' as const,
      created_at: 1,
    };
    expect(
      cardState(state('code-review', { enabled_repos: [repoA], history: [tile], runs: 7 })),
    ).toEqual({
      enabled: true,
      last: tile,
      runs: 7,
      repos: 1,
    });
  });

  it('colour tiles by result, lower is better', () => {
    expect(tileTone({ value: 'pass', status: 'passed' })).toBe('good');
    expect(tileTone({ value: 'low', status: 'passed' })).toBe('good');
    expect(tileTone({ value: 'medium', status: 'findings' })).toBe('warn');
    expect(tileTone({ value: 'fail', status: 'findings' })).toBe('bad');
    expect(tileTone({ value: 'high', status: 'findings' })).toBe('bad');
    expect(tileTone({ value: null, status: 'paused' })).toBe('neutral');
    expect(tileTone({ value: null, status: 'failed' })).toBe('bad');
  });

  it('draw the history strip as six slots, newest first, or say there are no runs', () => {
    const tiles = [1, 2].map((n) => ({
      id: `r${n}`,
      repo: repoA,
      change: n,
      value: 'pass' as const,
      status: 'passed' as const,
      created_at: n,
    }));
    const html = renderToStaticMarkup(createElement(HistoryStrip, { history: tiles }));
    expect(html.match(/result-tile/g)).toHaveLength(6);
    expect(html.match(/tone-good/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(HistoryStrip, { history: [] }))).toContain(
      'No runs yet',
    );
  });

  it('search and filter the agents', () => {
    const agents = [
      state('code-review', { enabled_repos: [repoA] }),
      state('security-review'),
      state('slop-review'),
    ];
    expect(visibleAgents(agents, 'security', false).map((a) => a.id)).toEqual(['security-review']);
    expect(visibleAgents(agents, '', true).map((a) => a.id)).toEqual(['code-review']);
  });

  it('show the promotional credit used', () => {
    const credit = { granted_usd: 5, used_usd: 1.25, balance_usd: 3.75, paused: false };
    expect(usedText(credit)).toBe('$1.25 used');
    expect(creditPercent(credit)).toBe(25);
    expect(creditPercent({ ...credit, used_usd: 9 })).toBe(100);
    expect(usedText({ ...credit, used_usd: 0 })).toBe('$0.00 used');
  });

  it('offer the account and each owned org as workspaces', () => {
    expect(
      workspaceOptions('mlong', [
        { org: 'zeta', role: 'owner' },
        { org: 'acme', role: 'member' },
        { org: 'beta', role: 'owner' },
      ]),
    ).toEqual([
      { value: 'mlong', label: 'mlong (you)' },
      { value: 'beta', label: 'beta (organization)' },
      { value: 'zeta', label: 'zeta (organization)' },
    ]);
  });
});

describe('the settings form', () => {
  it('pre-selects every repository on first enable, else the enabled ones', () => {
    expect(initialForm(state('code-review'), repos).repos).toEqual([repoA, repoB]);
    expect(initialForm(state('code-review', { enabled_repos: [repoB] }), repos).repos).toEqual([
      repoB,
    ]);
  });

  it('sends only what changed, null for a field set back to its default, and repos on first enable', () => {
    const fresh = state('code-review');
    const form = initialForm(fresh, repos);
    expect(updateBody(fresh, form)).toEqual({ repos: [repoA, repoB] });
    const enabled = state('code-review', {
      enabled_repos: [repoA],
      settings: { ...fresh.settings, reasoning: 'high' },
      customized: ['reasoning'],
    });
    const edit = {
      ...initialForm(enabled, repos),
      reasoning: 'medium' as const,
      timeout_minutes: 25,
    };
    expect(updateBody(enabled, edit)).toEqual({
      settings: { reasoning: null, timeout_minutes: 25 },
    });
    expect(updateBody(enabled, { ...initialForm(enabled, repos), repos: [repoA, repoB] })).toEqual({
      repos: [repoA, repoB],
    });
    expect(updateBody(enabled, initialForm(enabled, repos))).toEqual({});
  });

  it('keeps or replaces the model when the harness changes', () => {
    const form = initialForm(state('code-review'), repos);
    expect(withHarness(form, 'claude-code')).toMatchObject({
      harness: 'claude-code',
      provider: 'zai',
      model: 'glm-5.3-flash',
    });
    expect(withHarness(form, 'codex')).toMatchObject({
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
    });
  });

  it('lists each harness its providers models with prices including the margin', () => {
    const codex = modelOptions('codex');
    expect(codex.map((o) => o.value)).toEqual(['codex/gpt-5.6-luna']);
    expect(codex[0].text).toContain(`$${Number((0.2 * AGENT_MARGIN).toPrecision(6))} in`);
    expect(
      modelOptions('opencode').every((o) => o.provider === 'zai' || o.provider === 'mimo'),
    ).toBe(true);
    expect(modelOptions('claude-code').some((o) => o.provider === 'claude')).toBe(true);
    const glm = modelOptions('opencode').find((o) => o.model === 'glm-5.3-flash');
    expect(glm?.text).toBe('GLM-5.3 Flash · Z.ai · $0.195 in / $0.65 out per million tokens');
  });

  it('flags a bad form early', () => {
    const agent = state('code-review');
    expect(formProblem(agent, initialForm(agent, repos))).toBe('');
    expect(formProblem(agent, { ...initialForm(agent, repos), timeout_minutes: 99 })).toMatch(
      /timeout_minutes/,
    );
    expect(formProblem(agent, { ...initialForm(agent, repos), name: ' ' })).toMatch(/name/);
    expect(newAgentForm(repos)).toMatchObject({
      name: '',
      instructions: '',
      repos: [repoA, repoB],
    });
  });

  it('names customized fields, filters repositories and reads filters', () => {
    expect(customizedText(['model', 'provider', 'instructions'])).toBe('model and instructions');
    expect(customizedText(['reasoning'])).toBe('reasoning');
    expect(filterRepos(repos, 'WEB').map((r) => r.id)).toEqual([repoB]);
    expect(parseFilters('src/\n docs/ , src/\n')).toEqual(['src/', 'docs/']);
  });
});

describe('runs and billing', () => {
  it('format durations, costs and cost lines', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 min 5 s');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.254)).toBe('$1.25');
    const call = {
      kind: 'charge' as const,
      amount: -3250,
      model: 'glm-5.3-flash',
      input_tokens: 10_000,
      output_tokens: 2_000,
      cost_microusd: 2500,
      note: null,
      at: 1,
    };
    expect(costLabel(call)).toBe('glm-5.3-flash · 10000 in / 2000 out tokens');
    expect(costUsd(call)).toBe(0.00325);
    expect(
      costLabel({ ...call, input_tokens: null, output_tokens: null, note: 'Container 60 s' }),
    ).toBe('Container 60 s');
  });

  it('totals usage by repository and agent', () => {
    expect(
      usageTotals({
        usage: [
          { repo: repoA, repo_name: 'parser', agent: 'code-review', runs: 3, cost_usd: 0.25 },
          { repo: repoB, repo_name: 'web-app', agent: 'slop-review', runs: 1, cost_usd: 0.05 },
        ],
      }),
    ).toEqual({ runs: 4, cost_usd: 0.3 });
  });
});

describe('the pricing page agent rows', () => {
  it('price every rated model with the margin and name each default agent', () => {
    const rows = agentUsageRows();
    for (const row of rows) expect(row.output_price).toBeCloseTo(row.output * AGENT_MARGIN, 6);
    const defaults = rows.filter((r) => r.agents.length);
    expect(defaults.flatMap((r) => r.agents).sort()).toEqual(
      MANAGED_AGENTS.map((a) => a.defaults.name).sort(),
    );
    expect(rows.slice(0, defaults.length)).toEqual(defaults);
  });
});

// A WorkspaceState fixture stays assignable as the contract changes.
const _fixture: WorkspaceState = {
  workspace: 'mlong',
  agents: [state('code-review')],
  credit: { granted_usd: 5, used_usd: 0, balance_usd: 5, paused: false },
  billing: 'coming',
  repos,
  token_name: 'yoneda-managed-agents',
};
void _fixture;
