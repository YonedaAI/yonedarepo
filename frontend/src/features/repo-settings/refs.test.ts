// Branches and tags under History (controls for the write role and above), and the webhook
// form's events and path grant: the requests they send and the tables in each state.
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
const { SECTION_TITLES } = await import('./RepoSettings');
const { HistoryTab } = await import('../source-platform/HistoryTab');
const { canMoveBranches } = await import('../source-platform/repoStatus');
const { parseSourceRoute, formatSourceRoute, routeTab } = await import(
  '../source-platform/sourceRoute'
);

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

describe("the viewer's own changes before a read includes them", () => {
  // A refs read may predate the change (another isolate's snapshot): `stale` lacks it.
  const stale = { refs: { 'refs/heads/main': a, 'refs/heads/old': b }, version: 5 };
  const created = refModel.createdEdit({ ref: 'refs/heads/kit-ui-branch', commit: a, version: 6 });
  const shown = (read: typeof stale, edits: any[]) =>
    html(BranchTable, { refs: loaded({ data: refModel.withEdits(read, edits) }) });

  it('shows a created branch from its answer, whatever the reads say until one includes it', () => {
    expect(created).toEqual({ ref: 'refs/heads/kit-ui-branch', commit: a, version: 6 });
    expect(shown(stale, [created])).toContain('<td>kit-ui-branch</td>');
    expect(refModel.pendingEdits(stale, [created as any])).toHaveLength(1);
    // A read at the change's version or newer decides, even against the change.
    const current = { refs: stale.refs, version: 6 };
    expect(refModel.pendingEdits(current, [created as any])).toHaveLength(0);
    expect(shown(current, [created])).not.toContain('kit-ui-branch');
  });
  it('hides a deleted branch and shows a created tag the same way', () => {
    const deleted = refModel.deletedEdit({ name: 'old', commit: b }, { version: 7, refs: {} });
    const tag = refModel.createdEdit({ ref: 'refs/tags/v2', commit: b, tag: null, version: 8 });
    const data = refModel.withEdits(stale, [deleted, tag] as any[]);
    expect(refModel.branchRows(data?.refs).map((r) => r.name)).toEqual(['main']);
    expect(refModel.tagRows(data?.refs)).toEqual([{ name: 'v2', commit: b }]);
  });
  it('applies edits in version order and keeps nothing for a no-op answer', () => {
    const moved = { ref: 'refs/heads/kit-ui-branch', commit: b, version: 9 };
    expect(
      refModel.withEdits(stale, [moved, created as any])?.refs['refs/heads/kit-ui-branch'],
    ).toBe(b);
    expect(refModel.createdEdit({ ref: 'refs/heads/old', commit: b, already: true })).toBeNull();
    expect(refModel.withEdits(undefined, [moved])).toBeUndefined();
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
    const page = html(RepoBranches, { repo, canWrite: true });
    expect(page).toContain('protected');
    expect(page).toContain('aria-label="Delete branch zeta"');
    expect(page).not.toContain('Delete branch main');
    expect(page).toContain('aria-label="Create a branch"');
    expect(page).toContain('aria-label="Create a tag"');
    expect(page).toContain('<td>v1</td>');
  });
  it('shows the read role the list without controls', () => {
    state.value = loaded({ data: { refs } });
    const page = html(RepoBranches, { repo, canWrite: false });
    expect(page).toContain('<td>zeta</td>');
    expect(page).toContain('needs the write role');
    expect(page).not.toContain('Delete branch');
    expect(page).not.toContain('Create a branch');
    expect(page).not.toContain('Create a tag');
  });
  it('lets the write role and above move branches', () => {
    expect(canMoveBranches(undefined)).toBe(false);
    expect(canMoveBranches({ owner: false, role: 'read' })).toBe(false);
    for (const role of ['write', 'land', 'admin'] as const)
      expect(canMoveBranches({ owner: false, role })).toBe(true);
    expect(canMoveBranches({ owner: true, role: null })).toBe(true);
  });
  it('is a History view with its own address, not a settings section', () => {
    const route = { view: 'branches' as const, repo };
    expect(formatSourceRoute(route)).toBe(`/source/${repo}/branches`);
    expect(parseSourceRoute(formatSourceRoute(route), '')).toEqual(route);
    expect(parseSourceRoute(`/source/${repo}/settings/branches`, '')).toEqual(route);
    expect(routeTab(route)).toBe('history');
    state.value = loaded({ data: { refs } });
    const status = (role: string) => ({
      name: 'demo',
      version: 1,
      policy: {},
      viewer: { owner: false, role },
    });
    const tab = (role: string) =>
      html(HistoryTab, { route, status: status(role), navigate: () => {} });
    expect(tab('write')).toContain('aria-label="Create a branch"');
    expect(tab('write')).toMatch(/aria-pressed="true"[^>]*>Branches and tags/);
    expect(tab('read')).not.toContain('Create a branch');
    expect(Object.values(SECTION_TITLES)).not.toContain('Branches and tags');
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
