import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  refs: new Map<number, { current: unknown }>(),
  api: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: hooks.api }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!hooks.refs.has(i)) hooks.refs.set(i, { current: initial });
    return hooks.refs.get(i);
  },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.cells)) hooks.cells[i] = initial;
    return [
      hooks.cells[i],
      (value: unknown) => {
        hooks.cells[i] = value;
      },
    ];
  },
}));

import type { CampaignStatus } from './campaignView';
import { ReviewerCampaignActions } from './ReviewerCampaignActions';

const status: CampaignStatus = {
  campaign: { id: 'fresh', enabled: true, version: 1 },
  approval: { entry: { repo_id: 'repo' } },
  active_trial: null,
  active_trial_state: null,
  budget: { limit_microusd: 50e6, charged_microusd: 0 },
};
const snapshot = { runs: [], executions: [] } as unknown as Snapshot;
const change = vi.fn(async () => {}),
  refresh = vi.fn(),
  error = vi.fn();
function render(value = status, input = snapshot) {
  hooks.cursor = 0;
  return ReviewerCampaignActions({
    status: value,
    snapshot: input,
    onChange: change,
    onRefresh: refresh,
    onError: error,
  });
}
function find(node: ReactNode): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map(find).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === 'button' ? element : find(element.props.children);
}
beforeEach(() => {
  hooks.cells = [];
  hooks.refs = new Map();
  hooks.api.mockReset();
  change.mockClear();
  refresh.mockClear();
  error.mockClear();
});
describe('campaign mutation guards using offline transport', () => {
  it('does not resume a reservation when repository evidence shows the same run is already evaluating', () => {
    const tree = render(
      { ...status, active_trial: 'active', active_trial_state: 'reserved' },
      { ...snapshot, executions: [{ run_id: 'active', status: 'evaluating' }] },
    );
    expect(find(tree)?.props.disabled).toBe(true);
    expect(find(tree)?.props.children).toBe('Campaign running…');
    find(tree)?.props.onClick();
    expect(hooks.api).not.toHaveBeenCalled();
  });
  it('resumes the same server reservation only once while its acknowledgement is pending', async () => {
    let finish: (value: unknown) => void = () => {};
    hooks.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const action = find(
      render({ ...status, active_trial: 'active', active_trial_state: 'reserved' }),
    );
    const first = action?.props.onClick();
    const second = action?.props.onClick();
    expect(hooks.api.mock.calls).toEqual([['reviewer/campaign/resume', {}]]);
    finish({});
    await Promise.all([first, second]);
    expect(change).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('fails closed on missing or exhausted allowance and unknown active state', () => {
    for (const value of [
      { ...status, budget: undefined },
      { ...status, budget: { limit_microusd: 50e6, charged_microusd: 50e6 } },
      { ...status, active_trial: 'active', active_trial_state: null },
    ]) {
      const button = find(render(value));
      expect(button?.props.disabled).toBe(true);
      button?.props.onClick();
    }
    expect(hooks.api).not.toHaveBeenCalled();
  });
});
