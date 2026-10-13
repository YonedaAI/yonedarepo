import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  refs: new Map<number, { current: unknown }>(),
  effects: [] as (() => unknown)[],
}));
const transport = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({ api: transport }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] =
          typeof value === 'function'
            ? (value as (v: unknown) => unknown)(hooks.states[index])
            : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.refs.has(index)) hooks.refs.set(index, { current: initial });
    return hooks.refs.get(index);
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));

import { LegacyReviewerTrial as ReviewerTrial } from './LegacyReviewerTrial';
import { ReviewerTrial as ReviewerEntry } from './ReviewerTrial';

const snapshot = {
  repository: { id: 'sandbox' },
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
} as unknown as Snapshot;
let currentSnapshot = snapshot;
const onChange = vi.fn(async () => {});
const onError = vi.fn();
function render() {
  hooks.cursor = 0;
  hooks.effects = [];
  return ReviewerTrial({ snapshot: currentSnapshot, live: true, onChange, onError } as Parameters<
    typeof ReviewerTrial
  >[0]);
}
function elements(node: ReactNode, type: string): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const item = node as ReactElement<Record<string, any>>;
  return [...(item.type === type ? [item] : []), ...elements(item.props.children, type)];
}
function button(label: string) {
  const match = elements(render(), 'button').find((b) => renderToStaticMarkup(b).includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}
async function load(active_trial: string | null, active_trial_state: string | null) {
  transport.mockResolvedValue({
    active_trial,
    active_trial_state,
    budget: { limit: 50e6, charged: 0 },
  });
  render();
  hooks.effects[0]();
  await vi.waitFor(() => expect(renderToStaticMarkup(render())).not.toContain('Loading trial'));
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = new Map();
  hooks.effects = [];
  hooks.cursor = 0;
  currentSnapshot = snapshot;
  transport.mockReset();
  onChange.mockClear();
  onError.mockClear();
});
afterEach(() => vi.restoreAllMocks());

it('disables the trial action while server-confirmed work is running', async () => {
  await load('active', 'running');
  expect(button('Trial running').props.disabled).toBe(true);
  expect(renderToStaticMarkup(render())).not.toContain('Resume trial');
  expect(transport.mock.calls.every((call) => call.length === 1)).toBe(true);
});
it('keeps the action disabled if repository evidence shows work ahead of a stale reservation read', async () => {
  currentSnapshot = { ...snapshot, executions: [{ run_id: 'active', status: 'evaluating' }] };
  await load('active', 'reserved');
  expect(button('Trial running').props.disabled).toBe(true);
});
it('does not replace running status with a loading spinner during a slow background poll', async () => {
  await load('active', 'running');
  const interval = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  render();
  hooks.effects[1]();
  transport.mockImplementation(() => new Promise(() => {}));
  const poll = interval.mock.calls[0][0] as () => void;
  poll();
  poll();
  expect(transport).toHaveBeenCalledTimes(2);
  expect(button('Trial running').props.disabled).toBe(true);
  expect(renderToStaticMarkup(render())).not.toContain('Loading trial');
});
it('offers recovery only for an interrupted start and ignores repeated activation in flight', async () => {
  await load('active', 'reserved');
  let finish!: (value: unknown) => void;
  transport.mockImplementation((path: string) =>
    path === 'reviewer/resume'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({
          active_trial: 'active',
          active_trial_state: 'running',
          budget: { limit: 50e6, charged: 0 },
        }),
  );
  const resume = button('Resume interrupted start');
  const first = resume.props.onClick();
  const second = resume.props.onClick();
  expect(button('Resuming').props.disabled).toBe(true);
  expect(transport.mock.calls.filter((call) => call[0] === 'reviewer/resume')).toHaveLength(1);
  finish({ repo_id: 'sandbox', run_id: 'active' });
  await Promise.all([first, second]);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(button('Trial running').props.disabled).toBe(true);
});
it('links directly to the latest checked eligible result while another trial runs', async () => {
  currentSnapshot = {
    ...snapshot,
    runs: [
      { id: 'old', status: 'ready', created_at: 1 },
      { id: 'checked', status: 'ready', created_at: 2 },
      { id: 'latest', status: 'exploring', created_at: 3 },
    ],
    candidates: [
      { id: 'old-c', run_id: 'old', status: 'eligible' },
      { id: 'new-c', run_id: 'checked', status: 'eligible' },
    ],
  };
  await load('latest', 'running');
  const link = elements(render(), 'a').find((a) => a.props.children === 'Review checked result');
  expect(link?.props.href).toBe('/?repo=sandbox&run=checked');
  const html = renderToStaticMarkup(render());
  expect(html).toContain('Preview');
  expect(html).toContain('checks');
  expect(html).toContain('Evidence trail');
});
it('never offers stale candidates as checked results', async () => {
  currentSnapshot = {
    ...snapshot,
    runs: [{ id: 'stale', status: 'ready' }],
    candidates: [{ run_id: 'stale', status: 'stale' }],
  };
  await load(null, null);
  expect(renderToStaticMarkup(render())).not.toContain('Review checked result');
});
it('fails closed on an unknown active trial state', async () => {
  await load('active', null);
  expect(elements(render(), 'button')[0].props.disabled).toBe(true);
  expect(renderToStaticMarkup(render())).not.toContain('Resume interrupted start');
});
it('keeps the legacy live trial disabled in the reviewer entrypoint while the new campaign gate is disabled', async () => {
  transport.mockResolvedValue({ campaign: { enabled: false } });
  const entry = () => {
    hooks.cursor = 0;
    hooks.effects = [];
    return ReviewerEntry({ snapshot: currentSnapshot, onChange, onError });
  };
  entry();
  hooks.effects[0]();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledWith('reviewer/campaign'));
  expect(renderToStaticMarkup(entry())).not.toContain('Start new $5 trial');
  expect(transport.mock.calls.every((call) => call.length === 1)).toBe(true);
});
