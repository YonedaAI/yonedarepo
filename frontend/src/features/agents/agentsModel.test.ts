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
  type ManagedCredit,
  readyForReview,
  type WorkspaceState,
} from '../../../../shared/managed-agents';
import { agentUsageRows } from '../site/pricing';
import {
  formatSourceRoute,
  parseSourceRoute,
  routeTab,
  type SourceRoute,
} from '../source-platform/sourceRoute';
import { HistoryStrip } from './agentParts';
import {
  archivePath,
  cardState,
  checkPreview,
  costLabel,
  costUsd,
  createdText,
  creditPercent,
  formatCost,
  formatDuration,
  formatUtc,
  menuItems,
  READY_HELP,
  REPO_STATUS_LABELS,
  relativeTime,
  repoAgentsPath,
  reposText,
  runNowPath,
  runNowText,
  runsPath,
  syncAgents,
  syncPath,
  tileTone,
  triggerText,
  usageTotals,
  usedText,
  visibleAgents,
  workspaceOptions,
} from './agentsModel';
import { filterRepos, formProblem, initialForm, parseFilters, updateBody } from './setupForm';

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
    created_by: null,
    created_at: null,
    active: true,
    all_repos: false,
    ...over,
  };
}
/** Set up on `repos`, by ada, an hour before NOW. */
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const setUp = (over: Partial<AgentState> = {}): Partial<AgentState> => ({
  enabled_repos: [repoA],
  created_by: 'ada',
  created_at: NOW - 3_600_000,
  ...over,
});
const credit = (over: Partial<ManagedCredit> = {}): ManagedCredit => ({
  granted_usd: 5,
  used_usd: 1.25,
  promo: { usd: 100, granted: false },
  card: null,
  top_up_failed: null,
  auto_top_up: true,
  balance_usd: 3.75,
  paused: false,
  ...over,
});

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
  it('show not set up, or set up with status, the newest result and the run count', () => {
    expect(cardState(state('code-review'))).toMatchObject({
      configured: false,
      status: 'off',
      last: null,
      runs: 0,
    });
    const tile = {
      id: 'x',
      repo: repoA,
      change: 4,
      value: 'fail' as const,
      status: 'findings' as const,
      created_at: 1,
    };
    expect(
      cardState(state('code-review', setUp({ history: [tile], runs: 7, active: false }))),
    ).toEqual({
      configured: true,
      status: 'paused',
      last: tile,
      runs: 7,
      repos: '1 repository',
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
    const agents = [state('code-review', setUp()), state('security-review'), state('slop-review')];
    expect(visibleAgents(agents, 'security', false).map((a) => a.id)).toEqual(['security-review']);
    expect(visibleAgents(agents, '', true).map((a) => a.id)).toEqual(['code-review']);
  });

  it('show the credit used', () => {
    expect(usedText(credit())).toBe('$1.25 used');
    expect(creditPercent(credit())).toBe(25);
    expect(creditPercent(credit({ used_usd: 9 }))).toBe(100);
    expect(usedText(credit({ used_usd: 0 }))).toBe('$0.00 used');
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

describe('the set-up form', () => {
  it('pre-selects every repository and Active at first set-up, all repositories with none, else what is set', () => {
    expect(initialForm(state('code-review'), repos)).toEqual({
      trigger: state('code-review').settings.trigger,
      all_repos: false,
      repos: [repoA, repoB],
      active: true,
    });
    expect(initialForm(state('code-review'), [])).toMatchObject({ all_repos: true, repos: [] });
    expect(
      initialForm(state('code-review', setUp({ enabled_repos: [repoB], active: false })), repos),
    ).toMatchObject({ all_repos: false, repos: [repoB], active: false });
    expect(initialForm(state('code-review', setUp({ all_repos: true })), repos)).toMatchObject({
      all_repos: true,
    });
  });

  it('sends only the trigger, repositories and Active, never a field YonedaRepo maintains', () => {
    const fresh = state('code-review');
    expect(updateBody(fresh, initialForm(fresh, repos))).toEqual({
      repos: [repoA, repoB],
      active: true,
    });
    const enabled = state('code-review', setUp());
    const form = initialForm(enabled, repos);
    expect(updateBody(enabled, form)).toEqual({});
    const ready = { ...form.trigger, when: 'ready' as const };
    expect(updateBody(enabled, { ...form, trigger: ready })).toEqual({
      settings: { trigger: ready },
    });
    const customized = state(
      'code-review',
      setUp({ settings: { ...fresh.settings, trigger: ready }, customized: ['trigger'] }),
    );
    expect(
      updateBody(customized, {
        ...initialForm(customized, repos),
        trigger: fresh.defaults.trigger,
      }),
    ).toEqual({ settings: { trigger: null } });
    expect(updateBody(enabled, { ...form, repos: [repoA, repoB] })).toEqual({
      repos: [repoA, repoB],
    });
    expect(updateBody(enabled, { ...form, active: false })).toEqual({ active: false });
    // Whatever the form holds besides, the body names only editable keys.
    const tampered = { ...form, name: 'Mine', model: 'x', instructions: 'y' } as typeof form;
    for (const body of [updateBody(enabled, tampered), updateBody(fresh, tampered)]) {
      expect(
        Object.keys(body).every((k) => ['settings', 'repos', 'all_repos', 'active'].includes(k)),
      ).toBe(true);
      expect(Object.keys(body.settings ?? {})).not.toContain('name');
    }
  });

  it('sends all repositories instead of a list, and a list again when switched back', () => {
    const fresh = state('code-review');
    expect(updateBody(fresh, initialForm(fresh, []))).toEqual({ all_repos: true, active: true });
    const enabled = state('code-review', setUp());
    const form = initialForm(enabled, repos);
    expect(updateBody(enabled, { ...form, all_repos: true })).toEqual({ all_repos: true });
    const all = state('code-review', setUp({ all_repos: true, enabled_repos: [repoA, repoB] }));
    expect(updateBody(all, initialForm(all, repos))).toEqual({});
    expect(updateBody(all, { ...initialForm(all, repos), all_repos: false })).toEqual({
      repos: [repoA, repoB],
    });
  });

  it('flags a bad form early', () => {
    const agent = state('code-review');
    expect(formProblem(agent, initialForm(agent, repos))).toBe('');
    expect(formProblem(agent, initialForm(agent, []))).toBe('');
    expect(formProblem(agent, { ...initialForm(agent, repos), repos: [] })).toMatch(
      /at least one repository/,
    );
    const many = Array.from({ length: 30 }, (_, i) => `p${i}/`);
    const form = initialForm(agent, repos);
    expect(formProblem(agent, { ...form, trigger: { ...form.trigger, paths: many } })).not.toBe('');
  });

  it('filters repositories, reads filters and names where an agent runs', () => {
    expect(filterRepos(repos, 'WEB').map((r) => r.id)).toEqual([repoB]);
    expect(parseFilters('src/\n docs/ , src/\n')).toEqual(['src/', 'docs/']);
    expect(reposText({ all_repos: true, enabled_repos: [] })).toBe('All repositories');
    expect(reposText({ all_repos: false, enabled_repos: [repoA] })).toBe('1 repository');
    expect(reposText({ all_repos: false, enabled_repos: [repoA, repoB] })).toBe('2 repositories');
  });
});

describe('connecting new repositories', () => {
  it('posts to the workspace sync, answers what it connected, and swallows every failure', async () => {
    const calls: [string, object][] = [];
    const connected = await syncAgents('acme', async (path, init) => {
      calls.push([path, init]);
      return { connected: 2 };
    });
    expect(connected).toBe(2);
    expect(calls).toEqual([['/workspaces/acme/sync', { method: 'POST', body: {} }]]);
    expect(syncPath('dev.owner+x@example.com')).toBe(
      '/workspaces/dev.owner%2Bx%40example.com/sync',
    );
    for (const failure of ['NOT_FOUND', 'FORBIDDEN', 'network'])
      expect(
        await syncAgents('acme', async () => {
          throw new Error(failure);
        }),
      ).toBe(0);
    expect(await syncAgents('acme', async () => ({}))).toBe(0);
    let called = false;
    expect(
      await syncAgents(undefined, async () => {
        called = true;
        return { connected: 1 };
      }),
    ).toBe(0);
    expect(called).toBe(false);
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
  credit: credit({ used_usd: 0, balance_usd: 5 }),
  billing: 'coming',
  repos,
  token_name: 'yoneda-managed-agents',
};
void _fixture;

describe('the agent menu and pages', () => {
  it('offers Pause or Resume, Run now, Configure, Create your own (closed until billing) and Archive', () => {
    expect(menuItems(state('code-review'))).toEqual([]);
    const active = menuItems(state('code-review', setUp()));
    expect(active.map((i) => i.label)).toEqual([
      'Pause',
      'Run now',
      'Configure',
      'Create your own',
      'Archive',
    ]);
    expect(active.find((i) => i.action === 'create-own')).toMatchObject({
      disabled: true,
      hint: 'Creating your own agents is coming',
    });
    expect(active.find((i) => i.action === 'archive')?.danger).toBe(true);
    const paused = menuItems(state('code-review', setUp({ active: false })));
    expect(paused.map((i) => [i.label, Boolean(i.disabled)])).toEqual([
      ['Resume', false],
      ['Run now', true],
      ['Configure', false],
      ['Create your own', true],
      ['Archive', false],
    ]);
  });

  it('says what Run now did', () => {
    expect(runNowText({ started: 2, already: 0 })).toBe('Started 2 reviews.');
    expect(runNowText({ started: 1, already: 3 })).toBe('Started 1 review; 3 already reviewed.');
    expect(runNowText({ started: 0, already: 2 })).toBe(
      'Every open change is already reviewed at its head.',
    );
    expect(runNowText({ started: 0, already: 0 })).toBe('There is no open change to review.');
  });

  it('formats times in UTC, relative history and the trigger', () => {
    expect(formatUtc(Date.UTC(2026, 9, 30, 12, 19, 50))).toBe('2026-10-30 12:19 UTC');
    expect(relativeTime(NOW - 20_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 3_600_000, NOW)).toBe('1 hour ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago');
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).toBe('2026-08-01');
    expect(createdText(state('code-review', setUp()), NOW)).toBe('Created by ada, 1 hour ago');
    expect(createdText(state('code-review'))).toBe('Not set up yet');
    const trigger = state('code-review').settings.trigger;
    expect(triggerText(trigger)).toBe('On every push, changes ready for review');
    expect(
      triggerText({ ...trigger, when: 'ready', paths: ['src/'], branches: ['feature/*'] }),
    ).toBe('When marked ready, changes ready for review, paths src/; branches feature/*');
    expect(READY_HELP).toMatch(/unless its title starts with Draft: or WIP:/);
    expect(readyForReview({ status: 'open', title: 'WIP: parser' })).toBe(false);
    expect(readyForReview({ status: 'open', title: 'Parser fix' })).toBe(true);
  });

  it('previews the check for each result format', () => {
    expect(checkPreview(state('code-review')).map((l) => l.text)).toEqual([
      'code-review: pass',
      'code-review: fail',
    ]);
    expect(checkPreview(state('slop-review')).map((l) => [l.text, l.tone])).toEqual([
      ['slop-review: low', 'good'],
      ['slop-review: medium', 'warn'],
    ]);
  });

  it('addresses the new endpoints and the configure page', () => {
    expect(runNowPath('ada', 'code-review')).toBe('/workspaces/ada/agents/code-review/run');
    expect(archivePath('ada', 'code-review')).toBe('/workspaces/ada/agents/code-review/archive');
    expect(repoAgentsPath('ada', repoA)).toBe(`/workspaces/ada/repos/${repoA}/agents`);
    const route = { view: 'agent-configure', agent: 'code-review', workspace: 'acme' } as const;
    expect(formatSourceRoute(route)).toBe('/agents/code-review/configure?workspace=acme');
    expect(parseSourceRoute('/agents/code-review/configure', '?workspace=acme')).toEqual(route);
    expect(REPO_STATUS_LABELS.off).toBe('Not on this repository');
    const reviewers = parseSourceRoute('/source/r0123456789abcdef0123/agents/reviewers', '');
    expect(reviewers).toEqual({
      view: 'agents',
      repo: 'r0123456789abcdef0123',
      section: 'reviewers',
    });
    expect(routeTab(reviewers)).toBe('agents');
  });
});
