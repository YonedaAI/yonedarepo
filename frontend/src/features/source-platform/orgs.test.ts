// Organizations in the browser: the `/orgs/:org` route, the name and team-entry rules the
// forms use, the New repository owner picker, and the org page's states as the server
// would render them (loading, failed, member view, owner controls).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Record<string, Loaded<any>> } = { value: {} };
const pending: Loaded<any> = { loading: true, reload: () => {} };
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => (path && state.value[path]) || pending,
}));

const { formatSourceRoute, parseSourceRoute } = await import('./sourceRoute');
const { memberTarget, orgNameProblem, ownerOptions, teamNameProblem, teamOf, addableTo } =
  await import('./orgModel');
const { createBody } = await import('../shell/NewRepositoryDialog');
const { OrgPage } = await import('./OrgPage');
const { MemberName } = await import('./RepoMembers');
const { AccountOrgs, CreateOrganization, CreateOrgDialog } = await import('./AccountOrgs');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (data: unknown): Loaded<any> => ({ data, loading: false, reload: () => {} });
const org = {
  org: 'acme',
  created_at: 1,
  created_by: 'user:alice',
  role: 'owner',
  members: [
    { account: 'alice', role: 'owner', added_by: 'user:alice', added_at: 1 },
    { account: 'bob', role: 'member', added_by: 'user:alice', added_at: 2 },
  ],
  teams: [{ name: 'devs', created_by: 'user:alice', created_at: 3, members: ['bob'] }],
};
const navigate = () => {};

beforeEach(() => {
  state.value = {};
});

describe('org routes', () => {
  it('round-trips an org page and refuses malformed names', () => {
    expect(parseSourceRoute('/orgs/acme', '')).toEqual({ view: 'org', org: 'acme' });
    expect(formatSourceRoute({ view: 'org', org: 'acme' })).toBe('/orgs/acme');
    for (const bad of ['/orgs/Acme', '/orgs/ab', '/orgs/a@b.c', '/orgs/acme/teams', '/orgs'])
      expect(parseSourceRoute(bad, '')).toEqual({ view: 'home' });
  });
});

describe('org rules', () => {
  it('checks org and team names as the server does', () => {
    expect(orgNameProblem('acme_2')).toBe('');
    expect(orgNameProblem('2acme')).not.toBe('');
    expect(orgNameProblem('me@x.io')).not.toBe('');
    expect(teamNameProblem('devs')).toBe('');
    expect(teamNameProblem('0-ops_x')).toBe('');
    expect(teamNameProblem('-devs')).not.toBe('');
    expect(teamNameProblem('Devs')).not.toBe('');
  });
  it('names teams as repository member entries', () => {
    expect(memberTarget('team', 'acme/devs')).toBe('team:acme/devs');
    expect(memberTarget('team', ' team:acme/devs ')).toBe('team:acme/devs');
    expect(memberTarget('team', 'acme')).toBeNull();
    expect(memberTarget('team', 'acme/devs/x')).toBeNull();
    expect(memberTarget('account', ' bob ')).toBe('bob');
    expect(teamOf('team:acme/devs')).toEqual({ org: 'acme', team: 'devs' });
    expect(teamOf('bob')).toBeNull();
    expect(html(MemberName, { account: 'team:acme/devs' })).toContain('team</span> acme/devs');
  });
  it('offers only owned orgs as a new repository owner, sending owner only for one', () => {
    const orgs = [
      { org: 'zeta', role: 'owner' as const },
      { org: 'beta', role: 'member' as const },
      { org: 'acme', role: 'owner' as const },
    ];
    expect(ownerOptions('alice', orgs).map((o) => o.value)).toEqual(['', 'acme', 'zeta']);
    expect(createBody('svc', '', '')).not.toHaveProperty('owner');
    expect(createBody('svc', '', 'acme')).toMatchObject({ name: 'svc', owner: 'acme' });
  });
  it('picks team candidates from org members not on the team', () => {
    expect(addableTo(org.teams[0], org.members as any)).toEqual(['alice']);
  });
});

describe('org page', () => {
  it('shows loading, then a failure with retry', () => {
    expect(html(OrgPage, { org: 'acme', navigate })).toContain('Loading the organization');
    state.value['/orgs/acme'] = { loading: false, error: 'Not a member', reload: () => {} };
    const page = html(OrgPage, { org: 'acme', navigate });
    expect(page).toContain('Not a member');
    expect(page).toContain('Retry');
  });
  it('gives owners the controls and members a read-only view', () => {
    state.value['/orgs/acme'] = loaded(org);
    state.value['/orgs/acme/repos'] = loaded({
      repos: [{ id: `r${'a'.repeat(20)}`, name: 'svc', created_at: 4, owner: 'acme' }],
    });
    const owner = html(OrgPage, { org: 'acme', navigate });
    expect(owner).toContain('Add member');
    expect(owner).toContain('Create team');
    expect(owner).toContain('Remove bob from devs');
    expect(owner).toContain('team:acme/devs');
    expect(owner).toContain(`href="/source/r${'a'.repeat(20)}"`);
    state.value['/orgs/acme'] = loaded({ ...org, role: 'member' });
    const member = html(OrgPage, { org: 'acme', navigate });
    expect(member).not.toContain('Add member');
    expect(member).not.toContain('Create team');
    expect(member).not.toContain('Delete team');
    expect(member).toContain('devs');
  });
  it('says so when there are no teams or repositories', () => {
    state.value['/orgs/acme'] = loaded({ ...org, teams: [] });
    state.value['/orgs/acme/repos'] = loaded({ repos: [] });
    const page = html(OrgPage, { org: 'acme', navigate });
    expect(page).toContain('No teams yet');
    expect(page).toContain('No repositories you can use yet');
  });
});

describe('account organizations', () => {
  it('lists each org as a row linking to its page, with the role', () => {
    const page = html(AccountOrgs, {
      orgs: loaded({
        orgs: [
          { org: 'zeta', role: 'member' },
          { org: 'acme', role: 'owner' },
        ],
      }),
      navigate,
    });
    const rows = [...page.matchAll(/<a class="org-row" href="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['/orgs/acme', '/orgs/zeta']);
    expect(page).toContain('>owner<');
    expect(page).not.toContain('No organizations yet');
  });

  it('says there are none in a card of its own', () => {
    const page = html(AccountOrgs, { orgs: loaded({ orgs: [] }), navigate });
    expect(page).toContain(
      '<div class="settings-card settings-empty"><h2>No organizations yet</h2>',
    );
    expect(page).not.toContain('class="org-row"');
  });

  it('shows a slow or failed read', () => {
    expect(html(AccountOrgs, { orgs: pending, navigate })).toContain('Loading organizations');
    const failed = { ...pending, loading: false, error: 'boom' };
    expect(html(AccountOrgs, { orgs: failed, navigate })).toContain('Retry');
  });

  it('asks for the name only after Create organization is pressed', () => {
    const orgs = loaded({ orgs: [] });
    const button = html(CreateOrganization, { orgs, navigate });
    expect(button).toContain('>Create organization</button>');
    expect(button).not.toContain('<input');
    expect(html(AccountOrgs, { orgs, navigate })).not.toContain('<input');
    const dialog = html(CreateOrgDialog, { orgs, navigate, onClose: () => {} });
    expect(dialog).toContain('Organization name');
    expect(dialog).toMatch(/<button type="submit" disabled="">Create organization<\/button>/);
    expect(dialog).toContain('>Cancel</button>');
  });
});
