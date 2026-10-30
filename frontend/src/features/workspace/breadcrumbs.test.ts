// The top bar's breadcrumbs for a route: the account (home, or the org's page), Agents, then
// the page itself, with every crumb but the last a link.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { breadcrumbs } from './breadcrumbs';
import { WorkspaceHeader } from './WorkspaceHeader';

const home = { label: 'ada', to: { view: 'home' } };
const agents = { label: 'Agents', to: { view: 'agents-home' } };

describe('breadcrumbs', () => {
  it('trails every Agents page back to the account and the Agents page', () => {
    expect(breadcrumbs({ view: 'agents-home' }, 'ada')).toEqual([home, { label: 'Agents' }]);
    expect(breadcrumbs({ view: 'agent-settings', agent: 'code-review' }, 'ada')).toEqual([
      home,
      agents,
      { label: 'Code review' },
    ]);
    expect(breadcrumbs({ view: 'agent-settings', agent: 'new' }, 'ada')).toEqual([
      home,
      agents,
      { label: 'New agent' },
    ]);
    expect(breadcrumbs({ view: 'agent-configure', agent: 'code-review' }, 'ada')).toEqual([
      home,
      agents,
      { label: 'Code review', to: { view: 'agent-settings', agent: 'code-review' } },
      { label: 'Configure' },
    ]);
    expect(breadcrumbs({ view: 'agent-runs' }, 'ada')).toEqual([home, agents, { label: 'Runs' }]);
    expect(breadcrumbs({ view: 'agent-runs', agent: 'security-review' }, 'ada')).toEqual([
      home,
      agents,
      { label: 'Security review', to: { view: 'agent-settings', agent: 'security-review' } },
      { label: 'Runs' },
    ]);
    expect(
      breadcrumbs({ view: 'agent-run', runRepo: 'r0000000000000000000a', run: 'run1' }, 'ada'),
    ).toEqual([home, agents, { label: 'Runs', to: { view: 'agent-runs' } }, { label: 'Run' }]);
  });

  it("starts an org's Agents pages at the org, and keeps the workspace in every link", () => {
    expect(
      breadcrumbs({ view: 'agent-settings', agent: 'code-review', workspace: 'acme' }, 'ada'),
    ).toEqual([
      { label: 'acme', to: { view: 'org', org: 'acme' } },
      { label: 'Agents', to: { view: 'agents-home', workspace: 'acme' } },
      { label: 'Code review' },
    ]);
  });

  it('starts at Agents when the account is not known yet, and has none for other pages', () => {
    expect(breadcrumbs({ view: 'agent-runs' }, undefined)).toEqual([agents, { label: 'Runs' }]);
    expect(breadcrumbs({ view: 'settings' }, 'ada')).toBeNull();
    expect(breadcrumbs({ view: 'home' }, 'ada')).toBeNull();
  });
});

describe('the top bar', () => {
  const header = (crumbs: ReturnType<typeof breadcrumbs>) =>
    renderToStaticMarkup(
      createElement(WorkspaceHeader, {
        title: 'Agents',
        crumbs,
        loading: false,
        onRefresh: () => {},
        authenticated: false,
        identity: null,
        onSignIn: () => {},
        onSignOut: async () => {},
        onError: () => {},
      }),
    );

  it('links every crumb but the current page, which it marks', () => {
    const html = header(breadcrumbs({ view: 'agent-configure', agent: 'code-review' }, 'ada'));
    expect(html).toContain(
      '<nav aria-label="Breadcrumb" class="topbar-crumbs"><ol><li><a href="/">ada</a></li><li><a href="/agents">Agents</a></li><li><a href="/agents/code-review">Code review</a></li><li><span aria-current="page">Configure</span></li></ol></nav>',
    );
    expect(html).not.toContain('topbar-title');
    expect(header(null)).toContain('<p class="topbar-title">Agents</p>');
  });
});
