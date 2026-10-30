// Credentials and org administration in the browser: the request bodies the personal and
// repository token forms send (org limit, path grants), the fork owner picker's request,
// and deleting an organization (owners only, typed-name confirm, path encoding).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Record<string, Loaded<any>> } = { value: {} };
const pending: Loaded<any> = { loading: true, reload: () => {} };
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => (path && state.value[path]) || pending,
}));

const { pathList } = await import('./connect');
const { PatDialog, patBody, PatTable } = await import('./PersonalTokens');
const { repoTokenBody, RepoTokens } = await import('./RepoTokens');
const { forkRequest } = await import('./forks');
const { DeleteOrganization, orgDeletePath } = await import('./OrgDelete');
const { OrgPage } = await import('./OrgPage');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (data: unknown): Loaded<any> => ({ data, loading: false, reload: () => {} });
const repo = 'r0123456789abcdef0123';
const pat = {
  id: 'pat_1',
  name: 'ci',
  scopes: ['repo:read'],
  repos: null,
  org: 'acme',
  created_at: 1,
  expires_at: null,
  last_used_at: null,
};
const org = {
  org: 'acme',
  created_at: 1,
  created_by: 'user:alice',
  role: 'owner',
  members: [{ account: 'alice', role: 'owner', added_by: 'user:alice', added_at: 1 }],
  teams: [],
};

beforeEach(() => {
  state.value = {};
});

describe('token requests', () => {
  it('sends an org limit and repository allowlist only when chosen', () => {
    const form = { name: ' ci ', scopes: ['repo:read' as const], days: 7, repos: [], org: '' };
    expect(patBody(form)).toEqual({ name: 'ci', scopes: ['repo:read'], expires_days: 7 });
    expect(patBody({ ...form, org: 'acme', repos: [repo] })).toEqual({
      name: 'ci',
      scopes: ['repo:read'],
      expires_days: 7,
      repos: [repo],
      org: 'acme',
    });
  });
  it('reads path grants as typed, null for the whole repository', () => {
    expect(pathList('')).toBeNull();
    expect(pathList(' , \n')).toBeNull();
    expect(pathList('/src/, docs/README.md\nsrc/')).toEqual(['src/', 'docs/README.md']);
    expect(repoTokenBody(' agent ', ['read'], '')).toEqual({ name: 'agent', scopes: ['read'] });
    expect(repoTokenBody('agent', ['read', 'write'], 'src')).toEqual({
      name: 'agent',
      scopes: ['read', 'write'],
      paths: ['src'],
    });
  });
});

describe('token forms', () => {
  it('shows a token’s org limit and offers the caller’s orgs', () => {
    const table = html(PatTable, {
      tokens: loaded({ tokens: [pat, { ...pat, id: 'pat_2', name: 'any', org: null }] }),
      repos: [],
      onRevoke: () => {},
    });
    expect(table).toContain('<th>Organization</th>');
    expect(table).toContain('<td>acme</td>');
    expect(table).toContain('<td>any</td>');
    expect(table).toContain('aria-label="Revoke ci"');
    // The form lives in Create token's dialog.
    const props = { repos: [], onClose: () => {}, onCreated: () => {} };
    const form = html(PatDialog, {
      ...props,
      orgs: [
        { org: 'zeta', role: 'member' },
        { org: 'acme', role: 'owner' },
      ],
    });
    expect(form).toContain('aria-label="Create a personal access token"');
    expect(form).toMatch(/Any \(not limited\).*Only acme.*Only zeta/);
    expect(html(PatDialog, { ...props, orgs: [] })).not.toContain('pat-org');
  });
  it('offers a path grant on repository tokens', () => {
    state.value[`/repos/${repo}/tokens`] = loaded({
      tokens: [{ name: 'agent', scopes: ['read'] }],
    });
    const page = html(RepoTokens, { repo });
    expect(page).toContain('id="repo-token-paths"');
    expect(page).toContain('aria-label="Revoke agent"');
  });
});

describe('fork owner', () => {
  it('names an org owner only when one is chosen', () => {
    expect(forkRequest(repo, '', 'acme')).toEqual({
      path: `/repos/${repo}/fork`,
      body: { owner: 'acme' },
    });
    expect(forkRequest(repo, ' mine ', '').body).toEqual({ name: 'mine' });
  });
});

describe('delete organization', () => {
  it('confirms by the typed name, encoded', () => {
    expect(orgDeletePath('acme', 'acme')).toBe('/orgs/acme?confirm=acme');
    expect(orgDeletePath('acme', 'a&b c')).toBe('/orgs/acme?confirm=a%26b%20c');
    const form = html(DeleteOrganization, { org: 'acme', repoCount: 2, onDeleted: () => {} });
    expect(form).toContain('Type <strong>acme</strong> to confirm');
    expect(form).toContain('It owns 2 repositories you can see');
    expect(form).toMatch(/<button[^>]*disabled[^>]*>Delete this organization/);
  });
  it('is offered to owners only, with the repositories it still owns', () => {
    state.value['/orgs/acme'] = loaded(org);
    state.value['/orgs/acme/repos'] = loaded({
      repos: [{ id: repo, name: 'svc', created_at: 4, owner: 'acme' }],
    });
    const props = { org: 'acme', navigate: () => {}, onDeleted: () => {} };
    const owner = html(OrgPage, props);
    expect(owner).toContain('Delete organization');
    expect(owner).toContain('It owns 1 repository you can see');
    state.value['/orgs/acme'] = loaded({ ...org, role: 'member' });
    expect(html(OrgPage, props)).not.toContain('Delete this organization');
    state.value['/orgs/acme'] = loaded(org);
    state.value['/orgs/acme/repos'] = loaded({ repos: [] });
    expect(html(OrgPage, props)).not.toContain('It owns');
  });
});
