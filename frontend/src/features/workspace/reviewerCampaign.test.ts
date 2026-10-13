import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => undefined | (() => void))[],
  api: vi.fn(),
}));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: hooks.api,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => undefined | (() => void)) => hooks.effects.push(effect),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.states)) hooks.states[i] = initial;
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value;
      },
    ];
  },
}));

import { ReviewerTrial } from './ReviewerTrial';

const snapshot = {
  repository: { id: 'historical' },
  runs: [],
  executions: [],
  candidates: [],
} as unknown as Snapshot;
const status = {
  campaign: { id: 'fresh', version: 1, enabled: true },
  approval: { entry: { repo_id: 'app-repo' } },
};
const checked = {
  repo_id: 'app-repo',
  run_id: 'new-checked',
  candidate_id: 'captured',
  revision: { repository: 'fixture/fork', commit: 'exact' },
  evaluation_id: 'report',
};
function render() {
  hooks.cursor = 0;
  hooks.effects = [];
  return ReviewerTrial({ snapshot, onChange: async () => {}, onError: () => {} });
}
function find(node: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, type)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}
beforeEach(() => {
  hooks.states = [];
  hooks.api.mockReset();
});
describe('campaign reviewer default', () => {
  it('keeps a configured disabled campaign in preparing state without reverting to legacy trial entry', async () => {
    hooks.api.mockResolvedValueOnce({
      ...status,
      campaign: { ...status.campaign, enabled: false },
    });
    render();
    hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ loading: false }));
    const html = renderToStaticMarkup(render());
    expect(html).toContain('Reviewer campaign preparing');
    expect(html).not.toContain('Legacy live trials are disabled');
    expect(html).not.toContain('Start optional');
    expect(hooks.api.mock.calls).toEqual([['reviewer/campaign']]);
  });
  it('offers an explicitly optional metered action only after the enabled campaign and actual allowance are recorded', async () => {
    const funded = {
      ...status,
      active_trial: null,
      active_trial_state: null,
      budget: { limit_microusd: 50_000_000, charged_microusd: 12_000_000 },
    };
    hooks.api.mockResolvedValueOnce(funded).mockResolvedValueOnce(checked);
    render();
    hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ loading: false }));
    const html = renderToStaticMarkup(render());
    expect(html).toContain('Start optional $5 run');
    expect(html).toContain('$38.00');
    expect(hooks.api.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
  it('reads the new campaign gate before the checked result and never starts or resumes a trial', async () => {
    hooks.api.mockResolvedValueOnce(status).mockResolvedValueOnce(checked);
    render();
    hooks.effects[0]();
    await vi.waitFor(() =>
      expect(hooks.states[1]).toMatchObject({ enabled: true, checked, loading: false }),
    );
    const html = renderToStaticMarkup(render());
    expect(html).toContain('/?repo=app-repo&amp;run=new-checked');
    expect(html).toContain('Review checked app result');
    expect(html).not.toContain('Start new $5 trial');
    expect(hooks.api.mock.calls).toEqual([['reviewer/campaign'], ['reviewer/campaign/checked']]);
  });
  it('rejects a checked result from another repository and leaves mutations unavailable', async () => {
    hooks.api
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...checked, repo_id: 'wrong-repo' });
    render();
    hooks.effects[0]();
    await vi.waitFor(() =>
      expect(hooks.states[1]).toMatchObject({ enabled: true, checked: null, loading: false }),
    );
    expect(renderToStaticMarkup(render())).toContain('could not be verified');
    expect(renderToStaticMarkup(render())).not.toContain('Review checked app result');
  });
  it('clears an old checked link immediately on retry and ignores the old request after the enabled gate is revoked', async () => {
    let finish: (value: unknown) => void = () => {};
    hooks.api.mockResolvedValueOnce(status).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render();
    const cleanup = hooks.effects[0]();
    await vi.waitFor(() => expect(hooks.api).toHaveBeenCalledTimes(2));
    find(render(), 'button')?.props.onClick();
    if (typeof cleanup === 'function') cleanup();
    hooks.api.mockResolvedValueOnce(null);
    render();
    hooks.effects[0]();
    await vi.waitFor(() =>
      expect(hooks.states[1]).toMatchObject({ enabled: false, loading: false }),
    );
    finish(checked);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.states[1]).toMatchObject({ enabled: false, checked: null });
  });
});
