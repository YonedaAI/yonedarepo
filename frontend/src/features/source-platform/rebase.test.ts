// "Rebase on main" on the change page: offered only while the branch is behind main (main's
// head is not the merge base the change's diff was taken from).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('./useSource', () => ({ useSource: () => state.value }));

const { RebaseButton, rebaseState } = await import('./RebaseButton');

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const main = 'c'.repeat(40);
const change = (over: object = {}) =>
  ({
    number: 3,
    branch: 'topic/fix',
    base: 'main',
    status: 'open',
    head,
    diff: { base: { commit: base, tree: 't' }, head: { commit: head, tree: 't' }, changes: [] },
    ...over,
  }) as any;
const refs = (mainHead?: string) => ({
  loading: false,
  reload: () => {},
  data: { version: 4, refs: mainHead ? { 'refs/heads/main': mainHead } : {} },
});
const button = (c: any) =>
  renderToStaticMarkup(createElement(RebaseButton, { repo: 'r1', change: c, onChanged: () => {} }));

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('rebaseState', () => {
  it('is behind when main moved past the merge base', () => {
    expect(rebaseState(change(), main)).toBe('behind');
    // Unrelated histories have no merge base: behind as well.
    expect(
      rebaseState(change({ diff: { base: null, head: { commit: head }, changes: [] } }), main),
    ).toBe('behind');
  });
  it('is current when the merge base is main', () => {
    expect(rebaseState(change(), base)).toBe('current');
  });
  it('is unknown without main, a head or a diff', () => {
    expect(rebaseState(change(), undefined)).toBe('unknown');
    expect(rebaseState(change({ head: null }), main)).toBe('unknown');
    expect(rebaseState(change({ diff: null }), main)).toBe('unknown');
  });
});

describe('RebaseButton', () => {
  it('is enabled only while the branch is behind main', () => {
    state.value = refs(main);
    const behind = button(change());
    expect(behind).toContain('Rebase on main');
    expect(behind).not.toContain('disabled');
    state.value = refs(base);
    const current = button(change());
    expect(current).toContain('disabled');
    expect(current).toContain('Up to date with main');
  });
  it('stays disabled while main is loading or unreadable', () => {
    expect(button(change())).toContain('disabled');
    state.value = { loading: false, reload: () => {}, error: 'Network down' };
    expect(button(change())).toContain('disabled');
  });
});
