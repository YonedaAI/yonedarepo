// The Members panel as the server would render it: loading, failed, empty and populated
// states, and controls matched to the viewer (owner, admin, other member).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('./useSource', () => ({ useSource: () => state.value }));

const { MemberTable, RepoMembers, assignable } = await import('./RepoMembers');
const { formatSourceRoute, parseSourceRoute } = await import('./sourceRoute');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const owner = { owner: true, role: null };
const admin = { owner: true, role: 'admin' as const };
const members = [
  { account: 'ada', role: 'admin', added_by: 'user:alice', added_at: 1 },
  { account: 'bob', role: 'write', added_by: 'user:ada', added_at: 2 },
];
const handlers = { onRole: () => {}, onRemove: () => {} };

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('member table', () => {
  it('shows loading, failure, empty and populated states', () => {
    const props = { viewer: owner, ...handlers };
    expect(html(MemberTable, { ...props, members: loaded({ loading: true }) })).toContain(
      'Loading members',
    );
    expect(html(MemberTable, { ...props, members: loaded({ error: 'boom' }) })).toContain('Retry');
    expect(html(MemberTable, { ...props, members: loaded({ data: { members: [] } }) })).toContain(
      'Only the owner uses this repository',
    );
    const table = html(MemberTable, { ...props, members: loaded({ data: { members } }) });
    expect(table).toContain('<td>bob</td>');
    expect(table).toContain('by ada');
    expect(table).toContain('aria-label="Role of ada"');
    expect(table.match(/>Remove</g)).toHaveLength(2);
  });

  it('never lets an admin change or remove an admin', () => {
    const table = html(MemberTable, {
      viewer: admin,
      ...handlers,
      members: loaded({ data: { members } }),
    });
    expect(table).not.toContain('aria-label="Role of ada"');
    expect(table).toContain('<td>admin</td>');
    expect(table).toContain('aria-label="Role of bob"');
    expect(table).not.toContain('<option value="admin">');
    expect(table.match(/>Remove</g)).toHaveLength(1);
    expect(assignable(owner)).toEqual(['read', 'write', 'land', 'admin']);
    expect(assignable(admin)).toEqual(['read', 'write', 'land']);
  });
});

describe('members panel', () => {
  it('offers the add form to managers and only a description to other members', () => {
    state.value = loaded({ data: { members } });
    const managed = html(RepoMembers, { repo, viewer: owner });
    expect(managed).toContain('Add member');
    expect(managed).toContain('admin: also manage tokens');
    expect(html(RepoMembers, { repo, viewer: admin })).not.toContain('admin: also manage');
    const reader = html(RepoMembers, { repo, viewer: { owner: false, role: 'read' } });
    expect(reader).toContain('You are a member with the read role');
    expect(reader).not.toContain('Add member');
    expect(html(RepoMembers, { repo })).toContain('Loading your access');
  });

  it('has its own address', () => {
    const route = { view: 'members' as const, repo };
    expect(formatSourceRoute(route)).toBe(`/source/${repo}/members`);
    expect(parseSourceRoute(`/source/${repo}/members`, '')).toEqual(route);
  });
});
