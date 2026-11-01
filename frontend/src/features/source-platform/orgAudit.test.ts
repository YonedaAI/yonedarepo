// An organization's audit log in the browser: its route, paths and text, and the page's
// states as the server would render them (loading, failed, empty, rows, who sees the tab).
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
const { auditDetail, auditExportHref, auditLabel, auditPath, auditWho } = await import(
  './orgAuditModel'
);
const { OrgAudit } = await import('./OrgAudit');
const { OrgPage } = await import('./OrgPage');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (data: unknown): Loaded<any> => ({ data, loading: false, reload: () => {} });
const failed = (error: string): Loaded<any> => ({ error, loading: false, reload: () => {} });
const navigate = () => {};
const row = {
  seq: 2,
  kind: 'org.member_put',
  actor: 'user:alice',
  at: 1000,
  source: 'account:acme',
  source_seq: 2,
  details: { account: 'bob', role: 'member' },
  previous: 'a',
  hash: 'b',
};
const org = (extra: object) => ({
  org: 'acme',
  created_at: 1,
  created_by: 'user:alice',
  role: 'owner',
  members: [],
  teams: [],
  ...extra,
});

beforeEach(() => {
  state.value = {};
});

describe('org audit routes and paths', () => {
  it('round-trips the audit page and refuses anything under it', () => {
    expect(parseSourceRoute('/orgs/acme/audit', '')).toEqual({
      view: 'org',
      org: 'acme',
      tab: 'audit',
    });
    expect(formatSourceRoute({ view: 'org', org: 'acme', tab: 'audit' })).toBe('/orgs/acme/audit');
    expect(parseSourceRoute('/orgs/acme/audit/x', '')).toEqual({ view: 'home' });
  });

  it('pages by seq and carries the filters, encoded', () => {
    expect(auditPath('acme', { kind: '', actor: '' })).toBe('/orgs/acme/audit');
    expect(auditPath('acme', { kind: '', actor: '' }, 40)).toBe('/orgs/acme/audit?before=40');
    expect(auditPath('acme', { kind: 'org.deleted', actor: 'a@b.co' }, 9)).toBe(
      '/orgs/acme/audit?kind=org.deleted&actor=a%40b.co&before=9',
    );
    expect(auditExportHref('acme', 'csv', { kind: 'org.deleted', actor: '' })).toBe(
      '/api/v1/orgs/acme/audit/export?format=csv&kind=org.deleted',
    );
  });

  it('says who did what in words', () => {
    expect(auditWho(row)).toBe('alice');
    expect(auditWho({ ...row, actor: null })).toBe('Not recorded');
    expect(auditLabel('org.member_put')).toBe('Member added or changed');
    expect(auditLabel('repo.policy_changed')).toBe('Landing rules changed');
    expect(auditLabel('kind.from_later')).toBe('kind.from_later');
    expect(auditDetail(row)).toBe('account: bob · role: member');
    expect(auditDetail({ ...row, details: { scopes: ['repo:read', 'repo:land'] } })).toBe(
      'scopes: repo:read, repo:land',
    );
    expect(auditDetail({ ...row, details: {} })).toBe('');
  });
});

describe('the audit log page', () => {
  const props = { org: 'acme' };
  const first = '/orgs/acme/audit';

  it('shows loading, then a failure, then an empty log', () => {
    expect(html(OrgAudit, props)).toContain('Loading the audit log');
    state.value[first] = failed('Only an owner of acme can do this');
    expect(html(OrgAudit, props)).toContain('Only an owner of acme can do this');
    state.value[first] = loaded({ items: [], next: null });
    expect(html(OrgAudit, props)).toContain('Nothing has been recorded yet.');
  });

  it('lists rows, a way to the next page, filters and the exports', () => {
    state.value[first] = loaded({ items: [row], next: 2 });
    const page = html(OrgAudit, props);
    expect(page).toContain('Member added or changed');
    expect(page).toContain('alice');
    expect(page).toContain('account: bob · role: member');
    expect(page).toContain('Load more');
    expect(page).toContain('Event');
    expect(page).toContain('/api/v1/orgs/acme/audit/export?format=csv');
    expect(page).toContain('/api/v1/orgs/acme/audit/export?format=json');
  });

  it("doesn't offer exports or more while there's nothing to show", () => {
    state.value[first] = loaded({ items: [], next: null });
    const page = html(OrgAudit, props);
    expect(page).not.toContain('Load more');
  });
});

describe('the org page', () => {
  const on = { org: 'acme', navigate };

  it('gives owners a tab to the log when it is on', () => {
    state.value['/orgs/acme'] = loaded(org({ audit_log: true }));
    const page = html(OrgPage, on);
    expect(page).toContain('admin-tabs');
    expect(page).toContain('href="/orgs/acme/audit"');
    expect(page).toContain('Members');
  });

  it('hides the tab from members, and everywhere while it is off', () => {
    state.value['/orgs/acme'] = loaded(org({ audit_log: true, role: 'member' }));
    expect(html(OrgPage, on)).not.toContain('admin-tabs');
    state.value['/orgs/acme'] = loaded(org({}));
    expect(html(OrgPage, on)).not.toContain('admin-tabs');
  });

  it('shows the log on its tab instead of the org', () => {
    state.value['/orgs/acme'] = loaded(org({ audit_log: true }));
    state.value['/orgs/acme/audit'] = loaded({ items: [row], next: null });
    const page = html(OrgPage, { ...on, tab: 'audit' });
    expect(page).toContain('Member added or changed');
    expect(page).not.toContain('org-members-heading');
    expect(page).toContain('aria-current="page"');
  });

  it('explains why the log is not there, without asking', () => {
    state.value['/orgs/acme'] = loaded(org({ audit_log: true, role: 'member' }));
    expect(html(OrgPage, { ...on, tab: 'audit' })).toContain('Only owners of this organization');
    state.value['/orgs/acme'] = loaded(org({}));
    expect(html(OrgPage, { ...on, tab: 'audit' })).toContain('isn’t turned on');
  });
});
