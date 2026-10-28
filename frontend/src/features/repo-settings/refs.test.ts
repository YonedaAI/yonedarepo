// Branches and tags in Settings, and the webhook form's events and path grant: the requests
// they send and the tables in each state.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from '../source-platform/useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('../source-platform/useSource', () => ({ useSource: () => state.value }));

const refModel = await import('./refModel');
const { BranchTable, RepoBranches, TagTable } = await import('./RepoBranches');
const { HOOK_EVENTS, HOOK_EVENT_HELP, HookTable } = await import('./HookParts');
const { hookBody, RepoWebhooks } = await import('./RepoWebhooks');
const { RepoSettings } = await import('./RepoSettings');
const { parseSourceRoute, formatSourceRoute } = await import('../source-platform/sourceRoute');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const refs = {
  'refs/heads/zeta': b,
  'refs/heads/main': a,
  'refs/heads/feature/x': a,
  'refs/tags/v1': b,
};

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('ref rules and requests', () => {
  it('lists main first, then branches and tags by name', () => {
    expect(refModel.branchRows(refs).map((r) => r.name)).toEqual(['main', 'feature/x', 'zeta']);
    expect(refModel.tagRows(refs)).toEqual([{ name: 'v1', commit: b }]);
    expect(refModel.branchRows(undefined)).toEqual([]);
  });
  it('checks names as git does', () => {
    for (const ok of ['feature/login', 'v1.0.0', 'fix-1_2'])
      expect(refModel.refNameProblem(ok)).toBe('');
    for (const bad of ['a b', 'a..b', '.hidden', 'x/', 'a.lock', 'a@{1}', 'x:y', 'refs/heads/x'])
      expect(refModel.refNameProblem(bad)).not.toBe('');
  });
  it('creates on "no branch yet", deletes on the current value, tags optionally annotated', () => {
    expect(refModel.createBranchBody('topic', a)).toEqual({
      ref: 'topic',
      commit: a,
      expected: null,
    });
    expect(refModel.deleteBranchBody({ name: 'topic', commit: b })).toEqual({
      updates: [{ ref: 'refs/heads/topic', commit: null, expected: b }],
    });
    expect(refModel.createTagBody('v2', a, '  ')).toEqual({ name: 'v2', commit: a });
    expect(refModel.createTagBody('v2', a, ' Ship it ')).toEqual({
      name: 'v2',
      commit: a,
      message: 'Ship it',
    });
  });
});

describe('branches and tags panel', () => {
  it('shows loading, failure and empty states', () => {
    const onDelete = () => {};
    expect(html(BranchTable, { refs: loaded({ loading: true }), onDelete })).toContain(
      'Loading branches',
    );
    expect(html(BranchTable, { refs: loaded({ error: 'boom' }), onDelete })).toContain('Retry');
    expect(html(BranchTable, { refs: loaded({ data: { refs: {} } }), onDelete })).toContain(
      'No branches yet',
    );
    expect(html(TagTable, { refs: loaded({ data: { refs: {} } }) })).toContain('No tags yet');
  });
  it('protects main and offers delete on other branches, with create forms', () => {
    state.value = loaded({ data: { refs } });
    const page = html(RepoBranches, { repo });
    expect(page).toContain('protected');
    expect(page).toContain('aria-label="Delete branch zeta"');
    expect(page).not.toContain('Delete branch main');
    expect(page).toContain('aria-label="Create a branch"');
    expect(page).toContain('aria-label="Create a tag"');
    expect(page).toContain('<td>v1</td>');
  });
  it('is a settings section with its own address', () => {
    const route = { view: 'repo-settings' as const, repo, section: 'branches' as const };
    expect(parseSourceRoute(formatSourceRoute(route), '')).toEqual(route);
    state.value = loaded({ data: { refs } });
    const status = { name: 'demo', version: 1, policy: {}, viewer: { owner: true, role: null } };
    const page = html(RepoSettings, {
      repo,
      section: 'branches',
      status,
      navigate: () => {},
      onPolicySaved: () => {},
      onDeleted: () => {},
    });
    expect(page).toContain('Branches and tags');
    expect(page).toContain('aria-label="Create a branch"');
  });
});

describe('webhook events and paths', () => {
  it('offers change requests and releases, each explained', () => {
    expect(HOOK_EVENTS).toContain('change');
    expect(HOOK_EVENTS).toContain('release');
    for (const e of HOOK_EVENTS) expect(HOOK_EVENT_HELP[e]).toBeTruthy();
    state.value = loaded({ data: { hooks: [] } });
    const form = html(RepoWebhooks, { repo });
    expect(form).toContain('change request opened');
    expect(form).toContain('id="hook-paths"');
  });
  it('sends paths only when given and shows them in the table', () => {
    expect(hookBody(' https://ci.example.com ', ['land'], '')).toEqual({
      url: 'https://ci.example.com',
      events: ['land'],
    });
    expect(hookBody('https://x.io', ['change'], 'src/, docs')).toEqual({
      url: 'https://x.io',
      events: ['change'],
      paths: ['src/', 'docs'],
    });
    const hook = { id: 1, url: 'https://x.io', events: ['change'], active: true, created_at: 1 };
    const table = html(HookTable, {
      hooks: loaded({
        data: {
          hooks: [
            { ...hook, paths: '["src/"]' },
            { ...hook, id: 2 },
          ],
        },
      }),
      onDeliveries: () => {},
      onDelete: () => {},
    });
    expect(table).toContain('<td>src/</td>');
    expect(table).toContain('<td>all</td>');
  });
});
